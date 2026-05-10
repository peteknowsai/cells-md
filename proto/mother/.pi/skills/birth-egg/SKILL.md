---
name: birth-egg
description: Pre-warm a well into an "egg" — well-create, configure egress, install runtime tools, push DNA with placeholder identity, install packages, take a pristine checkpoint. The egg is identity-less until hatched.
allowed-tools: [bash, well_create, well_destroy, well_exec, well_push, well_egress_allow, well_checkpoint, report_outcome, read]
---

# Birth-Egg Ritual — Phase 0

Pre-warm a well so birth-from-egg ("hatching") can finish in seconds.
The egg has all the toolchain, all the universal env, all the DNA on
disk — but its `__NAME__` and `__THINKING__` placeholders are left
intact so hatch can substitute them per-cell.

The egg's well name is in the user's message; substitute it for
`<NAME>` in the steps that need a well target. **Do NOT** substitute
`<NAME>` into the DNA itself — those placeholders are hatch-time.

This skill is structurally a pruned version of the `birth` skill. Steps
4b, 4c, and 7 are skipped (per-cell). Step 11 (memory log) and step 12
(tell user) are also skipped — eggs aren't tracked in cells_activity
and there's no user-facing message to deliver.

Prefer the well_* tools for every step that has them. Use `bash` for
local-only operations on the Mac (e.g., reading `~/.cells/secrets.json`
or invoking helper scripts).

## Preconditions

- `well` CLI authenticated (verify with `well org list`)
- `~/.cells/secrets.json` contains `CELLS_PROXY_SECRET`
- No existing well with this egg name (the Bun CLI checks before invoking you)
- All `bash scripts/...` invocations are relative to the cells repo root (`~/Projects/cells`)

## Timing instrumentation

Same convention as the birth skill. The very first action of every
numbered step below is one local-`bash` call:

```bash
bash scripts/log-birth-step.sh <NAME> <step-number> <short-label>
```

Eggs use the same `~/.cells/logs/birth-timings/<NAME>.log` file as
birth, just with the egg well name. The harden loop ignores eggs.

## Handling transient failures

If a step's command exits non-zero AND the error message looks network-class, **retry the same step once after a 5-second wait** before reporting failure. If the retry also fails, then call `report_outcome` with `success: false, message: "step <N>: <first error> · retry: <retry error>"`.

Network-class errors that warrant a retry:
- `401 bad bearer` (the subscriptions proxy occasionally returns this on the first call)
- Any `5xx` from an HTTP call
- `ECONNRESET`, `ETIMEDOUT`, `dial tcp`, `connection refused`
- `npm ERR! network`, `fetch failed`, registry timeouts
- `well_exec` returning the timeout-kill tag (`[killed by well-tools after Ns]`) — that means the inner command stalled on the network; one retry is worth trying

Do **NOT** retry on:
- Logic errors (well already exists, malformed input, missing file, jq parse error)
- Authorization errors that aren't transient (403 forbidden, no token in secrets.json)
- Step 1 (well create) — let the CLI handle retry there if it wants to

Retry budget: at most one retry per step. Don't loop. If the second attempt fails the step, escalate to `report_outcome failure` and stop the ritual.

## 1. Create the well

> _Timing marker (run first via local `bash`):_ `bash scripts/log-birth-step.sh <NAME> 1 create-well`

Use `well_create` with `name: <NAME>`. Blocks ~15s until ready.

## 2. Configure egress (allow all)

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 2 egress-allow`

Use `well_egress_allow` with `name: <NAME>` and `domains: ["*"]`.

## 3. Install system tools and configure tmux

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 3 system-tools-tmux`

Identical to birth step 3 — installs bun, wells CLI, gh, the
terminal-editing toolkit (`micro`, `fzf`, `ripgrep`, `bat`), and writes
the standard `/cell/.tmux.conf`. The tmux conf has `__CELL_BG__`,
`__CELL_FG__`, and `__NAME__` placeholders — those stay until hatch.

Use `well_exec` for the curl installs and tmux config:

```bash
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://sprites.dev/install.sh | sh
GH_VERSION=2.62.0
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
  | sudo tar -xz -C /usr/local --strip-components=1 \
    "gh_${GH_VERSION}_linux_amd64/bin/gh"
mkdir -p ~/.local/bin
ln -sf /usr/bin/batcat ~/.local/bin/bat
```

Then write the standard tmux config (verbatim from the birth skill —
including the `__NAME__`, `__CELL_BG__`, `__CELL_FG__` placeholders;
hatch substitutes those).

Then install the apt baseline laptop-side:

```bash
bash scripts/apt-install-on-cell.sh <NAME> tmux micro fzf ripgrep bat
```

Verify every required binary is on PATH on the well:
`well_exec`-run `command -v bun tmux micro fzf rg batcat gh`.

**Phase checkpoint.** All system tools are installed and verified. Take a checkpoint: `well_checkpoint` with `name: <NAME>` and `comment: "phase-tools-v1"`.

## 4. Push the agent DNA (identity-less)

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 4 dna-push`

Use `well_push` with:
- `name: <NAME>`
- `localPath: /Users/pete/Projects/cells/proto/mother/dna`
- `remotePath: /cell`

Then substitute **only `__MODEL__` and `__PROVIDER__`** — these are
egg-time bake-ins. Leave `__NAME__` and `__THINKING__` as placeholders
for hatch.

```bash
sed -i 's/__MODEL__/<MODEL>/g' \
  /cell/SOUL.md \
  /cell/IDENTITY.md \
  /cell/.pi/settings.json

sed -i 's/__PROVIDER__/<PROVIDER>/g' \
  /cell/IDENTITY.md \
  /cell/.pi/settings.json
```

**Skip the `__NAME__`, `__THINKING__`, and `__MODEL_CHAIN__`
substitutions** — those are hatch-time (the cell-name, thinking level,
and per-cell fallback chain are all unknown at egg-bake; the hatch path
in `cli/cells.ts` fills them in). Skip step 4b (per-cell color) and
step 4c (per-cell status.json).

## 5. Install per-egg packages + prune extensions

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 5 bun-install-pi-extensions`

Run the baseline install in **three separate `well_exec` calls** so a hang in any one is reportable on its own. Don't chain these — when the npm registry stalls, we want the failure attributed to the right step, not buried in a multi-line blob.

**5a. Bun + Pi global install** — `well_exec` with `timeoutSeconds: 240`:

```bash
export PATH=$HOME/.bun/bin:$PATH
cd /cell && bun install --frozen-lockfile
bun install -g @mariozechner/pi-coding-agent@latest
```

Why 240s: legitimate run is ~60–90s. Doubling the budget catches npm-stall hangs without false-positiving on slow networks.

**5b. Cells CLI shim** — `well_exec` with `timeoutSeconds: 30`:

```bash
chmod +x /cell/bin/cells
mkdir -p ~/.local/bin
ln -sf /cell/bin/cells ~/.local/bin/cells
```

Why 30s: file ops only. Anything past 30s here means the VM is stuck.

**5c. Prune in-tree extensions per the egg's variant** — `well_exec` with `timeoutSeconds: 60`. For each name in `["memory", "mentality", "wiki", "dream"]` that is NOT in `<EXTENSIONS>`, delete the directory:

```bash
rm -rf /cell/.pi/extensions/<name>
```

**Do NOT register the optional extensions in `.pi/settings.json` here.**
Hatch will register the cell's chosen subset (which equals the egg's
remaining set, since pool key match means extensions are identical).

**5d. Install the egg's packages** — only those listed in `<PACKAGES>`. Run via `well_exec` with `timeoutSeconds: 120` per package — npm registry stalls have hung births for 50+ minutes in the wild. Fail fast and report the install step as the failure.

| package        | install spec        |
|----------------|---------------------|
| pi-web-access  | `npm:pi-web-access` |

```bash
pi install -l npm:pi-web-access
```

Skip if `<PACKAGES>` is empty.

**Phase checkpoint.** All packages and pruned extensions are now in place. Take a checkpoint: `well_checkpoint` with `name: <NAME>` and `comment: "phase-installed-v1"`.

## 6. Set up env shim and PATH

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 6 env-shim`

The system-wide env shim now lives at `/etc/profile.d/cells-env.sh` (root-owned, 0644). It's written by `cells bake` into every cell-base, so the egg already has it from the bake — this step is a no-op for eggs unless the bake regressed. Verify presence: `well_exec` `test -f /etc/profile.d/cells-env.sh && echo OK`.

## 6b. Inject shared secrets

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 6b secrets-inject`

Read `~/.cells/secrets.json` on the Mac and pass each key as a `well_create --env KEY=VALUE` pair (egg-bake time) — welld lands them in `/etc/environment`, PAM auto-loads on every shell, and `/etc/profile.d/cells-env.sh` re-exports under pi-ai's expected names. Universal across cells. **Don't write per-key files inside the well** — the bashrc.d-style approach was retired with the /cell migration.

## 6c. Verify pi-ai patches landed

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 6c proxy-wire`

The proxy URL rewrites + codex `extractAccountId` stub are baked into
`cell-base` by `cells bake` and survive forks. Verify presence rather
than re-apply:

```bash
well_exec '
grep -q "https://proxy.cells.md" /cell/node_modules/@mariozechner/pi-ai/dist/models.generated.js \
  && grep -q "function extractAccountId(token) { return \"\"" /cell/node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js \
  && echo OK
'
```

If the verify fails, the bake regressed — re-bake `cell-base` (don't try
to re-apply per-cell). The historical `scripts/configure-cell-proxy.sh`
host-side retrofit is retained for legacy `/home/well/agent` cells; new
`/cell` cells get patches at bake time.

**Phase checkpoint.** Proxy is wired. Take a checkpoint: `well_checkpoint` with `name: <NAME>` and `comment: "phase-proxy-v1"`.

## 8. Login shim

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 8 login-shim`

No-op under the /cell layout — `/etc/profile.d/cells-env.sh` is sourced automatically by `/etc/profile` on every login shell (bash/sh/dash). Skip this step entirely.

**Skip step 7 (site service registration).** Pi only starts at hatch.
Without site service, the egg's pi process never spawns, and the
well hibernates cleanly.

## 9. Pristine checkpoint

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 9 checkpoint`

Use `well_checkpoint` with `name: <NAME>` and `comment: "pristine-v1"`. This is the checkpoint hatch restores to if a previous hatch left state behind.

## 10. Report outcome

> _Timing marker:_ `bash scripts/log-birth-step.sh <NAME> 10 report-outcome`

Call `report_outcome`:

- On success: `report_outcome(success: true, message: "egg <NAME> ready · model=<MODEL> provider=<PROVIDER>")`
- On failure (any earlier step stopped you): `report_outcome(success: false, message: "stopped at step <N>: <what failed>")`

## On failure

Stop at the first failed step. Skip ahead to step 10 with `success: false`.
Don't try to recover automatically — the CLI sweeps the orphan well
on outcome failure.
