// Pure logic for `cells secret` — the per-cell app-secret primitive.
//
// A secret is a root:root 0600 file under /etc/cells.secrets.d/<KEY> on the
// cell, whose raw content IS the value. cells-env.sh exports each one, so it
// reaches every shell, job, talk-fork, and the site supervisor (all source
// that shim) — the same reach as CELLS_PROXY_SECRET, but for per-cell app
// secrets set AFTER birth (e.g. a scoped Convex deploy key).
//
// This module is IO-free on purpose: arg parsing, key validation, and the
// in-cell script builders are all pure so they unit-test without a VM. The
// IO (reading the value from env/file/stdin/prompt, the well-exec transport)
// lives in cells.ts. The value NEVER passes through here — only the key —
// because the key is the only part that's safe to log or template.

export const SECRETS_DIR = "/etc/cells.secrets.d";

// POSIX env-var name: a letter or underscore, then letters/digits/underscores.
// Because the key becomes a filename AND an `export KEY=...` target, this is
// also the injection guard — anything outside this set (slashes, `..`, shell
// metacharacters, spaces) is rejected, so the key can be safely interpolated
// into the in-cell script and used as a path component.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidSecretKey(key: string): boolean {
  return key.length > 0 && key.length <= 128 && KEY_RE.test(key);
}

// Names we refuse to set as an app secret. Two reasons:
//   - Execution-hijack vectors: exporting PATH / LD_PRELOAD / BASH_ENV / etc.
//     into every shell + the supervisor is a code-injection primitive.
//   - Substrate-owned identity/auth: CELLS_PROXY_SECRET and the bearer-derived
//     tokens are managed by /etc/environment + cells-env.sh; an app secret of
//     the same name would either fight them or be silently shadowed (the proxy
//     block re-exports after the app-secret block — see cells-env.sh ordering).
export const RESERVED_SECRET_KEYS: ReadonlySet<string> = new Set([
  // shell / loader execution control
  "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "IFS", "BASH_ENV",
  "ENV", "SHELLOPTS", "BASHOPTS", "PROMPT_COMMAND", "PS1", "PS2", "PS4",
  "GLOBIGNORE", "CDPATH", "BASH_FUNC",
  // identity / shell context
  "HOME", "USER", "LOGNAME", "SHELL", "CELL_NAME",
  // substrate-managed auth (set via /etc/environment + cells-env.sh)
  "CELLS_PROXY_SECRET", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY", "OPENAI_CODEX_API_KEY",
]);

export function validateSecretKey(
  key: string,
): { ok: true } | { ok: false; reason: string } {
  if (!isValidSecretKey(key)) {
    return {
      ok: false,
      reason:
        `invalid key "${key}" — must match [A-Za-z_][A-Za-z0-9_]* (≤128 chars). ` +
        `Keys are env-var names and filenames; no spaces, slashes, or metacharacters.`,
    };
  }
  if (RESERVED_SECRET_KEYS.has(key)) {
    return {
      ok: false,
      reason:
        `"${key}" is reserved — setting it as an app secret would hijack the ` +
        `shell/loader or fight substrate-managed auth. Pick a distinct name.`,
    };
  }
  return { ok: true };
}

// Where the secret value comes from on the Mac side. "auto" = decide at
// runtime: read piped stdin if stdin isn't a TTY, else prompt with echo off.
// There is deliberately NO "inline" source — a value passed as an argv token
// would leak into ps(1), shell history, and exec logs.
export type SecretSource =
  | { kind: "env"; name: string }
  | { kind: "file"; path: string }
  | { kind: "stdin" }
  | { kind: "auto" };

export type SecretCmd =
  | { action: "set"; cells: string[]; key: string; source: SecretSource }
  | { action: "list"; cells: string[] }
  | { action: "rm"; cells: string[]; key: string }
  | { action: "usage"; error?: string };

function splitCells(arg: string): string[] {
  return arg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parse `cells secret <action> ...`. `rest` is argv after the `secret` verb.
//   set  <cell[,cell2,…]> <KEY> [--from-env VAR | --from-file PATH | --stdin]
//   list <cell>
//   rm   <cell[,cell2,…]> <KEY>
export function parseSecretArgs(rest: string[]): SecretCmd {
  const action = rest[0] ?? "";
  const args = rest.slice(1);

  if (action !== "set" && action !== "list" && action !== "rm") {
    return { action: "usage", error: action ? `unknown secret action: ${action}` : undefined };
  }

  // Pull flags out of the positional stream.
  let source: SecretSource = { kind: "auto" };
  let sawSourceFlag = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    const setSource = (s: SecretSource) => {
      if (sawSourceFlag) return false;
      sawSourceFlag = true;
      source = s;
      return true;
    };
    if (a === "--stdin") { setSource({ kind: "stdin" }); continue; }
    if (a === "--from-env") { setSource({ kind: "env", name: args[++i] ?? "" }); continue; }
    if (a.startsWith("--from-env=")) { setSource({ kind: "env", name: a.slice("--from-env=".length) }); continue; }
    if (a === "--from-file") { setSource({ kind: "file", path: args[++i] ?? "" }); continue; }
    if (a.startsWith("--from-file=")) { setSource({ kind: "file", path: a.slice("--from-file=".length) }); continue; }
    positional.push(a);
  }

  const cellArg = positional[0] ?? "";
  const cells = splitCells(cellArg);

  if (action === "list") {
    if (cells.length === 0) return { action: "usage", error: "list needs a cell name" };
    if (sawSourceFlag) return { action: "usage", error: "list takes no value-source flag" };
    return { action: "list", cells };
  }

  // set / rm both need a key.
  const key = positional[1] ?? "";
  if (cells.length === 0 || !key) {
    return { action: "usage", error: `${action} needs <cell[,cell2,…]> <KEY>` };
  }
  // Guard the classic footgun: `cells secret set cell KEY=VALUE`. That puts the
  // value in argv. Refuse and point at the safe sources.
  if (key.includes("=")) {
    return {
      action: "usage",
      error:
        `pass the value via --from-env/--from-file/stdin, never as KEY=VALUE ` +
        `(an inline value leaks into ps, shell history, and exec logs).`,
    };
  }
  const v = validateSecretKey(key);
  if (!v.ok) return { action: "usage", error: v.reason };

  if (action === "rm") {
    if (sawSourceFlag) return { action: "usage", error: "rm takes no value-source flag" };
    return { action: "rm", cells, key };
  }
  return { action: "set", cells, key, source };
}

// ── in-cell script builders (key is pre-validated → safe to interpolate) ──

// Reads the value from stdin (never argv), writes it raw to a 0600 root file.
// `v=$(cat)` strips trailing newlines (a trailing \n silently breaks bearer
// tokens); printf writes the value with no added newline so the file content
// is exactly the secret. Emits SET on success for the caller to confirm.
export function buildSecretSetScript(key: string): string {
  const f = `${SECRETS_DIR}/${key}`;
  return [
    "set -euo pipefail",
    "umask 077",
    `sudo install -d -m 700 -o root -g root ${SECRETS_DIR}`,
    `v=$(cat)`,
    `printf '%s' "$v" | sudo tee ${f} >/dev/null`,
    `sudo chown root:root ${f}`,
    `sudo chmod 600 ${f}`,
    `echo SET`,
  ].join("\n");
}

export function buildSecretRmScript(key: string): string {
  const f = `${SECRETS_DIR}/${key}`;
  return [
    "set -euo pipefail",
    `if [ -f ${f} ]; then sudo rm -f ${f} && echo REMOVED; else echo ABSENT; fi`,
  ].join("\n");
}

// Lists key NAMES only — never values.
export function buildSecretListScript(): string {
  return `[ -d ${SECRETS_DIR} ] && ls -1 ${SECRETS_DIR} 2>/dev/null || true`;
}

export function parseSecretListOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
