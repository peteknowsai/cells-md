---
name: birth
description: Provision a new agent by forking the `cell-base` image into a fresh well, applying per-cell identity, registering the site service, and reporting outcome. Birth is fast (~15s) — heavy lifting (toolchain, DNA, pi install, proxy wiring) is pre-baked in `cell-base` via `cells bake`.
allowed-tools: [bash, well_create, well_destroy, well_exec, well_egress_allow, well_checkpoint, report_outcome, read]
---

# Birth Ritual — fork-from-image

Bring a new agent into being by forking the `cell-base` image (built by `cells bake`) into a fresh well, then applying the per-cell identity bake-in. The agent's name is in the user's message; substitute it for `<NAME>` in every step below.

`cell-base` already has bun, pi-coding-agent, terminal toolkit, the DNA at `~/agent` (with `__NAME__` / `__MODEL__` / `__PROVIDER__` / `__THINKING__` / `__MODEL_CHAIN__` placeholders intact), `bun install` done, pi-ai patches applied, and `~/.bashrc.d/` env shims in place. Birth's job is the per-cell delta: identity substitution, tmux color, optional extensions, site service.

Prefer the `well_*` tools where they exist — they're cleaner than shelling out and surface errors as structured tool results. The `bash` tool is for local-only operations on the Mac (e.g. reading `~/.cells/secrets.json` or invoking helper scripts).

## Preconditions

- `cell-base` image exists in welld (`well image list` should show it). If missing, run `cells bake` on the Mac before any birth.
- `~/.cells/secrets.json` contains `CELLS_PROXY_SECRET` and other shared secrets.
- No existing agent with this name (the Bun CLI checks before invoking you).
- All helper scripts in this skill are invoked by absolute path (`bash ~/Projects/cells/scripts/...`), so cwd doesn't matter. No need to `cd` anywhere first.

## Timing instrumentation

The very first action of **every** numbered step below is one local-`bash` call:

```bash
bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> <step-number> <short-label>
```

This appends a timestamp + label to `~/.cells/logs/birth-timings/<NAME>.log`. Drop the marker even if the step itself fails — the harden loop reads these to figure out where birth is spending time.

## Handling transient failures

If a step's command exits non-zero AND the error message looks network-class, retry the same step once after a 5-second wait before reporting failure. If the retry also fails, call `report_outcome` with `success: false, message: "step <N>: <first error> · retry: <retry error>"`.

Network-class errors that warrant a retry:
- `401 bad bearer` (the subscriptions proxy occasionally returns this on the first call)
- Any `5xx` from an HTTP call
- `ECONNRESET`, `ETIMEDOUT`, `dial tcp`, `connection refused`
- `well_exec` returning the timeout-kill tag (`[killed by well-tools after Ns]`)

Do NOT retry on:
- Logic errors (well already exists, malformed input, missing file, jq parse error)
- Authorization errors that aren't transient (403 forbidden)
- Step 1 (well_create) — let the CLI handle retry there

Retry budget: at most one retry per step. Don't loop.

## 1. Fork the cell-base image into a fresh well

> _Timing marker (run first via local `bash`):_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 1 well-create`

Read shared secrets from the Mac first (use local `bash`):

```bash
test -f ~/.cells/secrets.json || { echo "missing ~/.cells/secrets.json"; exit 1; }
jq -r 'to_entries[] | "\(.key)=\(.value)"' ~/.cells/secrets.json
```

Take that key-value list and pass it via `well_create`'s `env` parameter — welld lands each pair in `/etc/environment` on the well at first boot, PAM auto-loads it on every shell, and the in-image `~/.bashrc.d/` shims re-export under the names pi-ai expects.

Use `well_create` with:
- `name: <NAME>`
- `fromImage: "cell-base"`
- `env: ["KEY1=val1", "KEY2=val2", ...]` (one entry per line from secrets.json)

🚨 **The `env: [...]` parameter is NOT optional.** If you skip it, `/etc/environment` will be empty of secrets, the in-image `~/.bashrc.d/*` shims will silently no-op (they're conditional on `CELLS_PROXY_SECRET` being set), and the cell will fail step 4b verify. Every birth that has dropped this parameter has failed in exactly the same place. Pass the env every time, even if the secrets list is short.

Forks via APFS clonefile (sub-millisecond) + ~5s boot. The `well` user, SSH key, DNA, toolchain, and proxy patches are all already on disk from the bake — SSH works the moment the VM is up.

**Immediately after `well_create` returns success, sanity-check that env landed.** This is a one-line `well_exec` and takes ~200ms — it catches the `env: [...]` omission at the source instead of letting it cascade to step 4b:

```bash
grep -q '^CELLS_PROXY_SECRET=' /etc/environment && echo OK || { echo MISSING; exit 1; }
```

If this prints `MISSING`, you forgot `env: [...]` on `well_create`. Destroy the well via `well_destroy`, re-call `well_create` with the env list, and re-verify. Do not proceed to step 2 until the check prints `OK`.

## 2. Configure egress (allow all)

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 2 egress-allow`

Use `well_egress_allow` with `name: <NAME>` and `domains: ["*"]`. Egress policy is per-well config (not on disk), so it doesn't carry from the source image.

Don't proceed until egress succeeds — every later step depends on outbound HTTP working.

## 3. Apply per-cell identity to the baked DNA

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 3 identity-bake-in`

The DNA in `~/agent` is intact from the bake but still has placeholders. Use `well_exec` to substitute them:

```bash
sed -i 's/__NAME__/<NAME>/g' \
  ~/agent/AGENTS.md \
  ~/agent/SOUL.md \
  ~/agent/IDENTITY.md \
  ~/agent/CELLS.md \
  ~/agent/CONTACTS.md \
  ~/agent/HEARTBEAT.md \
  ~/agent/package.json

sed -i 's/__MODEL__/<MODEL>/g' \
  ~/agent/SOUL.md \
  ~/agent/IDENTITY.md \
  ~/agent/.pi/settings.json

sed -i 's/__PROVIDER__/<PROVIDER>/g' \
  ~/agent/IDENTITY.md \
  ~/agent/.pi/settings.json

sed -i 's/__THINKING__/<THINKING>/g' ~/agent/.pi/settings.json

# Substitute the model fallback chain as a literal JSON array. Use `|` as
# the sed delimiter so the slashes inside `provider/model:thinking` entries
# don't collide. <CHAIN_JSON> is already a valid JSON array string.
sed -i 's|__MODEL_CHAIN__|<CHAIN_JSON>|g' ~/agent/.pi/settings.json
```

### 3b. Per-cell tmux color chip

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 3b tmux-color`

The DNA's `~/.tmux.conf` ships with `__CELL_FG__` / `__CELL_BG__` / `__NAME__` placeholders in the status-left chip. Compute the color locally and substitute on the well:

```bash
# Locally on the Mac (use bash, NOT well_exec):
read CBG CFG < <(bash ~/Projects/cells/scripts/cell-color.sh <NAME>)

# Then well_exec to substitute:
sed -i "s|__CELL_BG__|$CBG|g; s|__CELL_FG__|$CFG|g; s|__NAME__|<NAME>|g" ~/.tmux.conf
```

### 3c. Per-cell status file

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 3c status-file`

The right side of the tmux bar reads `~/agent/.pi/status.json`. Write it now via `well_exec`:

```bash
mkdir -p ~/agent/.pi
cat > ~/agent/.pi/status.json <<'EOF'
{
  "harness": "<HARNESS>",
  "channels": []
}
EOF
```

The laptop's slack-binding code populates `channels` later if a slack channel is bound.

### 3d. Prune + register optional extensions

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 3d extensions`

The cell-base image ships with all four optional in-tree extensions (`memory`, `mentality`, `wiki`, `dream`) under `~/agent/.pi/extensions/`. Pi only loads what's listed in `.pi/settings.json` `extensions` — leaving an extension on disk without registering it does nothing.

For each name in `["memory", "mentality", "wiki", "dream"]` that is NOT in `<EXTENSIONS>`, delete the directory via `well_exec`:

```bash
rm -rf ~/agent/.pi/extensions/<name>
```

Then register the chosen ones in `.pi/settings.json`. The DNA template's `extensions` array only lists the always-installed ones (`use-max`, `codex-proxy`, `self`, `thinking`, `heartbeat-watch`). For each name in `<EXTENSIONS>`, append `.pi/extensions/<name>/index.ts` via `well_exec`:

```bash
jq --arg p ".pi/extensions/<name>/index.ts" \
  '.extensions += [$p]' ~/agent/.pi/settings.json \
  > /tmp/s.json && mv /tmp/s.json ~/agent/.pi/settings.json
```

If `<EXTENSIONS>` is empty, skip the registration but still prune all four directories.

### 3e. Install optional packages

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 3e packages`

If `<PACKAGES>` is empty, skip this sub-step entirely.

For each entry in `<PACKAGES>`, run the matching `pi install` via `well_exec` with `timeoutSeconds: 120`:

| package        | install spec        |
|----------------|---------------------|
| pi-web-access  | `npm:pi-web-access` |

Example for `<PACKAGES>` = `["pi-web-access"]`:

```bash
pi install -l npm:pi-web-access
```

Why 120s: npm registry stalls have hung births for 50+ minutes in the wild. Fail fast and surface the install step as the failure.

## 4. Register the `site` service + flip URL to public

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 4 site-service`

The cell's public face at `<NAME>.cells.md` is served by the cell itself — `~/agent/site/server.ts` is a Bun web server that the cell owns. The site server also spawns `pi --mode rpc` as a child and exposes `/agent` over WebSocket. The per-cell Cloudflare Worker (deployed by the `cells` CLI post-birth, not from inside this skill) holds a persistent outbound WebSocket to that endpoint.

Two pieces:

1. **Flip the well URL to `--auth=public`** so external WS upgrade requests can reach the site server. Security still holds because the site server requires `Authorization: Bearer <CELLS_PROXY_SECRET>` on the `/agent` upgrade — only the per-cell Worker knows the secret.

   ⚠️ Run this from your local `bash` tool ON THE MAC. The `well` CLI is a host binary — it does NOT exist inside the VM. Do NOT pass it through `well_exec`.

   ```bash
   well url update --auth public -s <NAME>
   ```

2. **Register the `site` service** — supervises `bun run server.ts` with `CELL_NAME` and `PORT=8080` set. Run from the Mac:

   ```bash
   bash ~/Projects/cells/scripts/register-site-service.sh <NAME>
   ```

After both pieces, `cells see <NAME>` should open `<NAME>.cells.md` in the browser.

### 4b. Verify the agent can talk

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 4b verify`

Before checkpointing, prove the agent is actually wired up. The most common silent failure is `/etc/environment` missing the auth secret because step 1's `well_create` was called without `env: [...]` — pi installs cleanly, the site server starts cleanly, but every prompt hangs on auth. A 30s smoke test catches this before we lock the broken state into a checkpoint.

Use `well_exec` with `timeoutSeconds: 60`:

```bash
cd ~/agent && for f in ~/.bashrc.d/*; do . "$f"; done && timeout 30 pi --print "say ok"
```

The bashrc.d sourcing matters: `well_exec` shells out via `bash -c` (not `-lc`), which skips `~/.bashrc` and therefore skips the proxy env files (`anthropic_proxy`, `codex_proxy`, `site_proxy`) that hold `ANTHROPIC_AUTH_TOKEN`, `OPENAI_CODEX_API_KEY`, and `CELLS_PROXY_SECRET`. Sourcing them explicitly mirrors what the site service does in `register-site-service.sh` — so a passing verify here proves the same env that production pi will have.

What success looks like: pi exits 0 within 30s with some short response. The content doesn't matter — exit-0-within-deadline proves env files exist with values, pi runs, model is reachable, proxy auth works.

What failure looks like:
- `timeout: sending signal` / exit 124 → pi hung, almost certainly missing auth env
- `command not found: pi` → cell-base install regressed (rare, file a bug)
- `cd: no such file or directory` → DNA push didn't land in step 3 (rare, file a bug)
- pi exits non-zero with an error message → read it; if it says anything about credentials, env, or 401, that's the missing-env case

If verify fails, skip ahead to step 6 with `success: false, message: "step 4b: verify failed — <pi error>. Likely cause: step 1's well_create was called without env from secrets.json; rebirth and confirm env: [...] was passed."`. Don't try to patch the cell in place — the orphan sweep is faster than diagnosing a half-born cell.

## 5. First checkpoint

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 5 checkpoint`

Use `well_checkpoint` with `name: <NAME>`. Cheap (~300ms) and gives a clean restore point if the cell wedges later.

## 6. Report outcome (mandatory)

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 6 report-outcome`

Call `report_outcome` to tell the Bun CLI whether the birth succeeded.

- On success: `report_outcome(success: true, message: "agent <NAME> alive")`
- On failure (any earlier step stopped you): `report_outcome(success: false, message: "stopped at step <N>: <what failed>")`

Without this call the CLI assumes failure and won't register the agent.

## 7. Record in memory (success only)

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 7 record-memory`

Append one line to `state/memory/project_cells_activity.md`:

`<UTC date HH:MM>  born        <NAME>      <terse notes>`

Use `date -u +"%Y-%m-%d %H:%M"` for the timestamp.

## 8. Tell the user

> _Timing marker:_ `bash ~/Projects/cells/scripts/log-birth-step.sh <NAME> 8 tell-user`

After reporting outcome, tell the user one line:

> Agent `<NAME>` is alive. Talk to it with `cells talk <NAME>`.

No caveats, no warnings, no future-state notes. Just the success line.

## On failure

Stop at the first failed step. Skip ahead to step 6 with `success: false` and a message describing what broke. Don't record in memory (step 7) on failure. Don't try to recover automatically — the CLI sweeps the orphan well on outcome failure.
