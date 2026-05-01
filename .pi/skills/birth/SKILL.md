---
name: birth
description: Provision a new agent on a fresh Sprite. Creates the VM, configures egress, installs runtime tools, pushes the recipe-compliant template, runs `bun install`, injects the OAuth token, installs the login shim, and takes the first checkpoint.
allowed-tools: [bash, sprite_create, sprite_destroy, sprite_exec, sprite_push, sprite_egress_allow, sprite_checkpoint, report_outcome, read]
---

# Birth Ritual — Phase 0

Bring a new agent into being on a fresh Sprite. The agent's name is in the
user's message; substitute it for `<NAME>` in every step below.

This ritual follows `~/Projects/cells/PI-FIRST-PARTY-BILLING-RECIPE.md`. Every
step matters — if you shortcut, the agent silently lands on extra-usage billing.

Prefer the sprite_* tools for every step that has them — they're cleaner than
shell-out and surface errors as structured tool results. The `bash` tool is
still available for local-only operations on the Mac (e.g., reading
`~/.cell/secrets.json`).

## Preconditions

- `sprite` CLI authenticated (verify with `sprite org list`)
- `~/.cell/secrets.json` contains `CELLS_PROXY_SECRET` (the bearer token cells use to reach the mother's proxy at `https://keeper.cells.md`)
- No existing agent with this name (the Bun CLI checks before invoking you)

## 1. Create the Sprite

Use `sprite_create` with `name: <NAME>`. Blocks ~15s until ready.

## 2. Configure egress (allow all)

Use `sprite_egress_allow` with `name: <NAME>` and `domains: ["*"]`. This opens
outbound to any host so the agent can research, fetch, and install freely.

Don't proceed until this succeeds — every later step depends on egress.

## 3. Install system tools and configure tmux

Bun is not pre-installed on Sprite VMs. tmux often is, but install/upgrade it
to be safe — Pi runs inside a tmux session, so the agent's continuity depends
on it. Pi also uses modified-Enter keys (Shift+Enter for newline, plain Enter
to submit) which require tmux's `extended-keys` to be on.

Also install the `sprite` CLI on the Sprite — the `self-tools` extension
needs it to let the agent operate on its own sprite (checkpoint, egress,
inspect). The CLI authenticates from `SPRITES_TOKEN` env var, which gets
injected from `~/.cell/secrets.json` in step 6b. If that key isn't in the
secrets file, the API-based self-tools simply return a clear error;
`talk_to_self` works regardless.

Use `sprite_exec` with this command:

```bash
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://sprites.dev/install.sh | sh
sudo apt-get update -y
sudo apt-get install -y tmux
cat > /home/sprite/.tmux.conf << 'EOF'
# Pi compatibility — modified-Enter keys, csi-u format
set -g extended-keys on
set -g extended-keys-format csi-u
set -g default-terminal "tmux-256color"

# Mouse + scrollback
set -g mouse on
set -g history-limit 50000

# Highlight-to-copy: release mouse and selection lands in system clipboard via OSC52.
# Default copy mode is emacs (vanilla, no vi keys).
set -g set-clipboard on
bind -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel

# Snappy escape (helps Pi UI responsiveness)
set -sg escape-time 0

# Status-line input uses emacs keys (sensible default).
set -g status-keys emacs

# Aggressive resize for grouped sessions / multi-monitor.
setw -g aggressive-resize on

# Windows count from 1; renumber when one closes
set -g base-index 1
setw -g pane-base-index 1
set -g renumber-windows on

# Focus events forwarded (for editors that care)
set -g focus-events on
EOF
ls -la /home/sprite/.bun/bin/bun && tmux -V
```

## 4. Push the agent template

The repo's `template/` directory contains the canonical recipe-compliant
layout (AGENTS.md stub, .pi/agents/self.md persona, .pi/extensions/identity,
.pi/settings.json, package.json, .gitignore).

Use `sprite_push` with:
- `name: <NAME>`
- `localPath: /Users/pete/Projects/cell/template`
- `remotePath: /home/sprite/agent`

Then substitute `__NAME__` with the actual name. Use `sprite_exec`:

```bash
sed -i 's/__NAME__/<NAME>/g' /home/sprite/agent/AGENTS.md /home/sprite/agent/.pi/agents/self.md /home/sprite/agent/package.json
```

## 5. Run `bun install`, install Pi globally, install web-access, install `cells` CLI

`bun install` is mandatory — without `node_modules/`, the identity extension
fails to load and the agent silently lands on extra-usage billing.

Pi itself is **not** pre-installed on Sprite VMs. Install it globally via Bun
so the `pi` command is on PATH for the interactive shell.

Then install `pi-web-access` (project-local) via Pi's own package manager —
this registers the `web_search`, `fetch_content`, `code_search`, and
`get_search_content` tools the agent uses to browse the web. Works without
API keys (uses Exa MCP free tier); for higher rate limits inject an Exa key
later.

Use `sprite_exec`:

The template ships with `bin/cells` — a slim on-sprite CLI (read+talk only,
backed by the Sprites HTTP API). Make it executable and symlink onto PATH
so both the agent's bash and the `self-tools` extension can call it.

```bash
export PATH=$HOME/.bun/bin:$PATH
cd /home/sprite/agent && bun install
bun install -g @mariozechner/pi-coding-agent@latest
pi install -l npm:pi-web-access
pi install -l git:github.com/peteknowsai/pi-cell-memory@main
pi install -l git:github.com/peteknowsai/pi-cell-mentality@main
pi install -l git:github.com/peteknowsai/pi-cell-wiki@main
pi install -l git:github.com/peteknowsai/pi-cell-dream@main
chmod +x /home/sprite/agent/bin/cells
mkdir -p /home/sprite/.local/bin
ln -sf /home/sprite/agent/bin/cells /home/sprite/.local/bin/cells
```

The four `pi-cell-*` packages are the Cell memory architecture:

- `pi-cell-memory` — atoms + yearnings, `write_memory` / `write_yearning` tools, MEMORY.md always-loaded
- `pi-cell-mentality` — single `mentality.md` synthesis, always-loaded
- `pi-cell-wiki` — deep narrative knowledge, lazy-queried
- `pi-cell-dream` — async learner, four-phase consolidation from past sessions

Storage packages (memory / mentality / wiki) function standalone. Dream is
the optional accelerant. They auto-register via Pi's package discovery.

## 6. Set up the env shim and PATH

Sprites' Ubuntu non-interactive login shells (`bash -lc 'cmd'`, used by
`sprite exec`) bail out of `.bashrc` before reaching the end. So we source
`~/.bashrc.d/*` from `~/.profile` instead — that runs for *every* login
shell, interactive or not. Also drop a `bashrc.d/bun` file so Bun is on
PATH everywhere.

Use `sprite_exec`:

```bash
mkdir -p /home/sprite/.bashrc.d

grep -q bashrc.d /home/sprite/.profile || cat >> /home/sprite/.profile << 'EOF'

# agent: load env from ~/.bashrc.d/ for all login shells (interactive and non-interactive)
for f in /home/sprite/.bashrc.d/*; do [ -r "$f" ] && . "$f"; done
EOF

cat > /home/sprite/.bashrc.d/bun << 'EOF'
export PATH=$HOME/.bun/bin:$PATH
EOF
```

## 6b. Inject shared secrets from `~/.cell/secrets.json`

Every cell gets the same shared secrets, read from `~/.cell/secrets.json`
on the Mac and written one-file-per-key into `/home/sprite/.bashrc.d/` on
the Sprite. Don't echo any values in your reply.

Local bash to read the file (use `bash`, not `sprite_exec`):

```bash
test -f ~/.cell/secrets.json && jq -r 'keys[]' ~/.cell/secrets.json
```

Then for each `KEY: value` pair (other than `CELLS_PROXY_SECRET` — handled
in step 6c), write to the Sprite. Per-key files keep rotation granular.
Example for `EXA_API_KEY`:

```bash
sprite exec -s <NAME> -- bash -c "
cat > /home/sprite/.bashrc.d/exa << 'EOF'
export EXA_API_KEY='<value>'
EOF
chmod 600 /home/sprite/.bashrc.d/exa
"
```

`ANTHROPIC_API_KEY` is intentionally absent from `secrets.json` — cells
route through the mother's proxy and don't hold real Anthropic credentials.
The legacy approach was to push a frozen OAuth access token; it expired
hours after birth.

## 6c. Wire the cell to the mother's proxy

Cells reach Anthropic via `https://keeper.cells.md`, which the mother
laptop runs (single OAuth principal for the whole fleet). This step does
two things:

1. Drops `~/.bashrc.d/anthropic_proxy` with the shared bearer secret
   (`CELLS_PROXY_SECRET` from `~/.cell/secrets.json`) as `ANTHROPIC_AUTH_TOKEN`.
2. Patches the hardcoded `api.anthropic.com` URL in `pi-ai`'s model registry
   to `keeper.cells.md`. Pi does NOT respect `ANTHROPIC_BASE_URL` — the URL
   is baked per-model in `models.generated.js`. The patch is idempotent.

Use local `bash`:

```bash
scripts/configure-cell-proxy.sh <NAME>
```

This runs after `bun install` (step 5) so the model file exists. If the
cell ever runs `bun install` again, this script must be re-run — the model
registry will be clobbered and the cell will start hitting `api.anthropic.com`
directly with the proxy secret (which Anthropic rejects). Also re-run if
you rotate `CELLS_PROXY_SECRET`.

Background: see `memory/project_mother_proxy.md` and
`memory/reference_pi_internals.md` for why this is necessary.

## 7. Register the `agent` service (auto-start Pi on VM boot)

Without this, Pi only starts when a human attaches interactively (the
shell shim in step 8). That breaks any automation that wakes a hibernated
cell — the VM is up but Pi isn't running.

Register a Sprite *service* named `agent`. Sprites "services" are a
platform feature: they keep a process running, restart it on crash, and
auto-start it when the VM boots. They're not exposed by the `sprite` CLI,
but available via HTTP API.

Use local `bash` (not `sprite_exec` — the call goes from your Mac to the
Sprites API):

```bash
scripts/register-agent-service.sh <NAME>
```

The script reads `SPRITES_TOKEN` from `~/.cell/secrets.json` and PUTs a
service that runs `tmux new-session -dA -s agent pi` plus a wait loop.
The loop keeps the service process alive while the tmux session exists,
so Sprites considers the service "running" and doesn't restart it
unnecessarily.

## 8. Login shim — auto-attach to Pi TUI

Sprite's interactive shell is **zsh** (despite `/etc/passwd` listing /bin/bash
as the login shell), so the shim must go in both `.zshrc` and `.bashrc`. zsh
doesn't auto-source `.bashrc.d`, so we also have to source it explicitly from
`.zshrc`.

Use `sprite_exec`:

```bash
cat >> /home/sprite/.bashrc << 'EOF'

# agent: auto-attach to Pi TUI on interactive login
if [ -z "$TMUX" ] && [ -t 0 ]; then
  cd /home/sprite/agent
  exec tmux new-session -A -s agent pi
fi
EOF

cat >> /home/sprite/.zshrc << 'EOF'

# agent: source bashrc.d for env (PATH, ANTHROPIC_AUTH_TOKEN, etc)
for f in /home/sprite/.bashrc.d/*; do source $f; done

# agent: auto-attach to Pi TUI on interactive login
if [[ -z "$TMUX" && -t 0 ]]; then
  cd /home/sprite/agent
  exec tmux new-session -A -s agent pi
fi
EOF
```

## 9. First checkpoint

Use `sprite_checkpoint` with `name: <NAME>`.

## 10. Report outcome (mandatory)

Call `report_outcome` to tell the Bun CLI whether the birth succeeded.

- On success: `report_outcome(success: true, message: "agent <NAME> alive")`
- On failure (any earlier step stopped you): `report_outcome(success: false, message: "stopped at step <N>: <what failed>")`

Without this call the CLI assumes failure and won't register the agent.

## 11. Record in memory (success only)

Add `<NAME>` to the roster and log the birth event:

- Append one line to `memory/project_cells_activity.md`:
  `<UTC date HH:MM>  born        <NAME>      <terse notes>`
- Add a new row in the table in `memory/project_cells_roster.md`.

Use `date -u +"%Y-%m-%d %H:%M"` for the timestamp.

## 12. Tell the user

After reporting outcome, tell the user one line:

> Agent `<NAME>` is alive. Talk to it with `cells talk <NAME>`.

No caveats, no warnings, no future-state notes. Just the success line.

## On failure

Stop at the first failed step. Skip ahead to step 10 with `success: false`
and a message describing what broke. Don't record in memory (step 11) on
failure. Don't try to recover automatically.
