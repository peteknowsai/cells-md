/**
 * Per-session config — the primitive that makes HARNESS a per-SESSION attribute
 * instead of a per-cell identity. Pure: types, path resolution, validation, and
 * the harness-resolution decision. No IO, no spawning (the supervisor owns the
 * readFile, exactly as session-pool.ts / jobs.ts split pure-from-IO).
 *
 * A cell already ships every harness binary + config tree; "the cell's harness"
 * is just the default the supervisor drives `main` through. A NAMED session can
 * override it: `buyer` runs pi/gpt-5.5 (flat ChatGPT-sub cost) while `staff`
 * runs claude/opus on the warm interactive pool (cc_entrypoint=cli, Max sub) —
 * same VM, same /root, shared memory, different hats.
 *
 * The sidecar is JSON at /root/.cell/session-config/<name>.json:
 *   { "harness": "claude-code", "model": "anthropic/opus-4-8:medium", "role": "staff" }
 * All fields optional. Absent file (or absent field) → fall back to the cell
 * default: the session runs the cell's baked harness, the harness's own model,
 * and the role named after the session (/root/.cell/roles/<session>.md if present).
 *
 * Design: docs/proposals/uniform-multi-harness-cell.html
 */

import { isInsideDir } from "./path-guard";
import { validateSessionName } from "./session-pool";

// ---- registry paths --------------------------------------------------------

// Per-session {harness,model,role} sidecars. Sibling of /root/.cell/sessions/
// (which holds the harness-specific durable session ids the adapters resume).
export const SESSION_CONFIG_DIR = "/root/.cell/session-config";
// Per-session/per-role system-prompt preambles (the "hat"). A role file is the
// session's role override; absent → the session inherits the cell's SOUL only.
export const ROLES_DIR = "/root/.cell/roles";

// ---- harness vocabulary ----------------------------------------------------

// The harnesses a session may run. hermes is intentionally excluded — it has no
// durable named-session primitive (askInSession is undefined) and is the parked,
// weakest harness; the uniform-cell trio is pi + claude-code + codex.
export const SESSION_HARNESSES = ["pi", "claude-code", "codex"] as const;
export type SessionHarness = (typeof SESSION_HARNESSES)[number];

export function isSessionHarness(v: unknown): v is SessionHarness {
  return typeof v === "string" && (SESSION_HARNESSES as readonly string[]).includes(v);
}

// ---- config shape ----------------------------------------------------------

export type SessionConfig = {
  // Which harness runs this session. Absent → the cell's baked harness.
  harness?: SessionHarness;
  // Provider/model[:effort], harness's own format — e.g. "anthropic/opus-4-8:medium"
  // (claude), "gpt-5.5:low" (pi/codex). Absent → the harness's configured default.
  model?: string;
  // Role name → ROLES_DIR/<role>.md system-prompt preamble. Absent → the session
  // name doubles as the role (so `staff` looks up roles/staff.md automatically).
  role?: string;
};

// ---- path resolution (defense-in-depth via isInsideDir) --------------------

// Config sidecar for a validated session name. null for an invalid/escaping name.
export function sessionConfigPath(name: string): string | null {
  if (!validateSessionName(name)) return null;
  const p = `${SESSION_CONFIG_DIR}/${name}.json`;
  return isInsideDir(SESSION_CONFIG_DIR, p) ? p : null;
}

// Role-preamble file for a validated role name (same charset as a session name).
// null for an invalid/escaping name.
export function rolePath(role: string): string | null {
  if (!validateSessionName(role)) return null;
  const p = `${ROLES_DIR}/${role}.md`;
  return isInsideDir(ROLES_DIR, p) ? p : null;
}

// ---- model-spec validation -------------------------------------------------

// A model spec goes into the harness command (set_model / --model / config),
// some paths shell-interpolated. Restrict to the characters a real provider/
// model/effort string uses so a config file can never inject a shell token.
const MODEL_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,79}$/;

export function validateModelSpec(raw: unknown): string | null {
  return typeof raw === "string" && MODEL_SPEC_RE.test(raw) ? raw : null;
}

// ---- pure parse ------------------------------------------------------------

// Validate a parsed-JSON value into a SessionConfig, dropping any field that
// doesn't pass (an unknown harness, a junk model, a bad role name) rather than
// throwing — a malformed sidecar degrades to "use the cell default", never to a
// crash or an injected token. Returns {} for non-objects.
export function parseSessionConfig(raw: unknown): SessionConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const cfg: SessionConfig = {};
  if (isSessionHarness(o.harness)) cfg.harness = o.harness;
  const model = validateModelSpec(o.model);
  if (model) cfg.model = model;
  const role = typeof o.role === "string" && validateSessionName(o.role) ? o.role : null;
  if (role) cfg.role = role;
  return cfg;
}

// ---- harness + role resolution ---------------------------------------------

// The effective harness for a session: its configured override, else the cell's
// baked default. The cell default is passed in (the supervisor's HARNESS) so this
// stays pure and testable.
export function effectiveHarness(cfg: SessionConfig | null, cellDefault: string): string {
  return cfg?.harness ?? cellDefault;
}

// The effective role NAME for a session: its configured override, else the
// session name itself (so a `staff` session auto-resolves roles/staff.md). The
// caller turns the name into a path via rolePath and reads it (absent file → no
// role preamble, the common case).
export function effectiveRole(cfg: SessionConfig | null, sessionName: string): string {
  return cfg?.role ?? sessionName;
}
