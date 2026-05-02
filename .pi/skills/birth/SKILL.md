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
`~/.cells/secrets.json`).

## Preconditions

- `sprite` CLI authenticated (verify with `sprite org list`)
- `~/.cells/secrets.json` contains `CELLS_PROXY_SECRET` (the bearer token cells use to reach the mother's proxy at `https://mother.cells.md`)
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

Also install the standard terminal-editing toolkit (`micro`, `fzf`,
`ripgrep`, `bat`) — see `docs/terminal-setup.md`. These power the `mf` /
`mft` shell helpers wired up in step 6 and make it easy for a human (or
the agent) to navigate and edit files on the cell. On Ubuntu `bat` ships
as `batcat` due to a binary-name conflict, so we symlink it to `bat`.

Also install the `sprite` CLI on the Sprite — the `self` extension
needs it to let the agent operate on its own sprite (checkpoint, egress,
inspect). The CLI authenticates from `SPRITES_TOKEN` env var, which gets
injected from `~/.cells/secrets.json` in step 6b. If that key isn't in the
secrets file, the API-based self tools simply return a clear error;
`talk_to_self` works regardless.

Use `sprite_exec` with this command:

```bash
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://sprites.dev/install.sh | sh
sudo apt-get update -y
sudo apt-get install -y tmux micro fzf ripgrep bat
mkdir -p /home/sprite/.local/bin
ln -sf /usr/bin/batcat /home/sprite/.local/bin/bat
cat > /home/sprite/.tmux.conf << 'EOF'
# Pi compatibility — modified-Enter keys, csi-u format
set -g extended-keys on
set -g extended-keys-format csi-u
set -g default-terminal "tmux-256color"
set -ag terminal-overrides ",xterm-256color:RGB"

# Prefix: Ctrl+Space (avoids C-b's collision with readline back-char)
unbind C-b
set -g prefix C-Space
bind C-Space send-prefix

# Mouse + scrollback
set -g mouse on
set -g history-limit 50000

# Highlight-to-copy: release mouse and selection lands in system clipboard via OSC52.
# Lock mode-keys to emacs — tmux otherwise picks vi when $EDITOR=vim, which
# silently breaks scroll/copy-mode keybinds (e.g. `i` does nothing). Exit
# copy-mode with `q` or Esc.
setw -g mode-keys emacs
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

# Auto-rename windows to the basename of the pane's cwd
set -g automatic-rename on
set -g automatic-rename-format '#{b:pane_current_path}'

# Splits inherit cwd and run a login zsh (same env as `cells shell`).
# Directional: `prefix Right` = split right, `prefix Down` = split down.
# Symbolic: `prefix |` and `prefix -` do the same.
# `prefix x` (default) closes a pane with confirmation.
# (Rebinding arrows means losing default prefix-arrow pane navigation;
# use the mouse, or `prefix o` to cycle panes.)
bind Right split-window -h -c "#{pane_current_path}" "zsh -l"
bind Down  split-window -v -c "#{pane_current_path}" "zsh -l"
bind '|'   split-window -h -c "#{pane_current_path}" "zsh -l"
bind '-'   split-window -v -c "#{pane_current_path}" "zsh -l"

# Status line — cell name on the left (#S = session name = cell name)
set -g status-position bottom
set -g status-justify left
set -g status-style 'bg=default'
set -g status-left ' #S '
set -g status-left-style 'fg=#1F1F28,bg=#957FB8,bold'
set -g status-left-length 20
set -g status-right ''

set -g pane-border-lines single
set -g pane-border-style 'fg=#54546D'
set -g pane-active-border-style 'fg=#957FB8'

setw -g window-status-separator ''
setw -g window-status-format '  #I:#W #F  '
setw -g window-status-style 'bg=default,fg=#C8C093'
setw -g window-status-current-format '  #I:#W #F  '
setw -g window-status-current-style 'bg=default,fg=#957FB8,bold'
setw -g mode-style 'fg=#1F1F28,bg=#7E9CD8'

# Bell notifications: Pi rings the terminal bell when a response is ready.
# bell-action other = flash only when the window isn't currently focused.
setw -g monitor-bell on
set -g bell-action other
setw -g window-status-bell-style 'fg=#C8C093,dotted-underscore'
EOF
ls -la /home/sprite/.bun/bin/bun && tmux -V
```

## 4. Push the agent template

The repo's `template/` directory contains the canonical recipe-compliant
layout (AGENTS.md persona, .pi/extensions/use-max, .pi/settings.json,
package.json, .gitignore).

Use `sprite_push` with:
- `name: <NAME>`
- `localPath: /Users/pete/Projects/cells/template`
- `remotePath: /home/sprite/agent`

Then substitute `__NAME__`, `__MODEL__`, `__PROVIDER__`, and `__THINKING__`
with their actual values. Use `sprite_exec`:

```bash
sed -i 's/__NAME__/<NAME>/g' /home/sprite/agent/AGENTS.md /home/sprite/agent/package.json
sed -i 's/__MODEL__/<MODEL>/g' /home/sprite/agent/AGENTS.md /home/sprite/agent/.pi/settings.json
sed -i 's/__PROVIDER__/<PROVIDER>/g' /home/sprite/agent/.pi/settings.json
sed -i 's/__THINKING__/<THINKING>/g' /home/sprite/agent/.pi/settings.json
```

## 5. Run `bun install`, install Pi globally, install web-access, install `cells` CLI

`bun install` is mandatory — without `node_modules/`, the use-max extension
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
so both the agent's bash and the `self` extension can call it.

First, prune the in-tree optional extensions the user did NOT pick. The
template ships with all four (`memory`, `mentality`, `wiki`, `dream`) under
`/home/sprite/agent/.pi/extensions/`; we keep only those listed in
`<EXTENSIONS>` and delete the rest.

The always-installed extensions (`use-max`, `self`) stay regardless.

For each name in `["memory", "mentality", "wiki", "dream"]` that is NOT in
`<EXTENSIONS>`, delete the directory via `sprite_exec`:

```bash
rm -rf /home/sprite/agent/.pi/extensions/<name>
```

If `<EXTENSIONS>` is `["memory", "wiki"]`, delete `mentality` and `dream`.
If `<EXTENSIONS>` is empty, delete all four.

Then run the baseline install:

```bash
export PATH=$HOME/.bun/bin:$PATH
cd /home/sprite/agent && bun install
bun install -g @mariozechner/pi-coding-agent@latest
chmod +x /home/sprite/agent/bin/cells
mkdir -p /home/sprite/.local/bin
ln -sf /home/sprite/agent/bin/cells /home/sprite/.local/bin/cells
```

Then install the optional packages — only those listed in `<PACKAGES>`. If
`<PACKAGES>` is empty, skip this block entirely.

For each entry in `<PACKAGES>`, run the matching `pi install`:

| package        | install spec        |
|----------------|---------------------|
| pi-web-access  | `npm:pi-web-access` |

Example: if `<PACKAGES>` is `["pi-web-access"]`, run via `sprite_exec`:

```bash
pi install -l npm:pi-web-access
```

The optional in-tree extensions are the Cell memory architecture:

- `memory` — atoms + yearnings, `write_memory` / `write_yearning` tools, MEMORY.md always-loaded
- `mentality` — single `mentality.md` synthesis, always-loaded
- `wiki` — deep narrative knowledge, lazy-queried
- `dream` — async learner, four-phase consolidation from past sessions

Storage extensions (memory / mentality / wiki) function standalone. Dream is
the optional accelerant. Pi auto-discovers extensions in `.pi/extensions/`
on session start.

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
export PATH=$HOME/.local/bin:$HOME/.bun/bin:$PATH
EOF

cat > /home/sprite/.bashrc.d/terminal << 'EOF'
# Standard terminal-editing setup (see docs/terminal-setup.md):
# fzf is gitignore-aware via ripgrep; preview pane uses bat.
export FZF_DEFAULT_COMMAND='rg --files --hidden --glob "!.git"'
export FZF_DEFAULT_OPTS='--height 80% --reverse --border --preview "bat --style=numbers --color=always --line-range=:300 {} 2>/dev/null || ls -la {}" --preview-window=right:60%'

# mf: fuzzy-pick a file anywhere in the tree, open in micro.
alias mf='f=$(fzf) && [ -n "$f" ] && micro "$f"'

# mft: browse mode — descend folders, open files, .. to go up.
mft() {
  local cur="$PWD"
  while true; do
    local pick
    pick=$( { echo ".."; ls -A1 "$cur"; } | fzf --prompt="$cur > " ) || return
    if [ "$pick" = ".." ]; then
      cur=$(dirname "$cur")
    elif [ -d "$cur/$pick" ]; then
      cur="$cur/$pick"
    else
      micro "$cur/$pick"
      return
    fi
  done
}
EOF
```

## 6b. Inject shared secrets from `~/.cells/secrets.json`

Every cell gets the same shared secrets, read from `~/.cells/secrets.json`
on the Mac and written one-file-per-key into `/home/sprite/.bashrc.d/` on
the Sprite. Don't echo any values in your reply.

Local bash to read the file (use `bash`, not `sprite_exec`):

```bash
test -f ~/.cells/secrets.json && jq -r 'keys[]' ~/.cells/secrets.json
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

Cells reach both Anthropic (Claude Max) and OpenAI Codex (ChatGPT Plus)
via `https://mother.cells.md`, which the mother laptop runs as the single
OAuth principal for both subscriptions across the whole fleet. This step
does five things:

1. Drops `~/.bashrc.d/anthropic_proxy` with the shared bearer secret
   (`CELLS_PROXY_SECRET` from `~/.cells/secrets.json`) as `ANTHROPIC_AUTH_TOKEN`.
2. Drops `~/.bashrc.d/codex_proxy` with the same secret as `OPENAI_CODEX_API_KEY`,
   read by the `mother-codex` extension at pi startup.
3. Drops `~/.bashrc.d/site_proxy` with the same secret as `MOTHER_SECRET`,
   read by the cell's site server (`~/agent/site/server.ts`). The site
   server gates incoming requests on `x-mother-secret` matching this; only
   mother (which adds the header on forward) can reach the cell.
4. Patches the hardcoded `api.anthropic.com` URL in `pi-ai`'s model registry
   to `mother.cells.md`. Pi does NOT respect `ANTHROPIC_BASE_URL` — the URL
   is baked per-model in `models.generated.js`. The patch is idempotent.
5. Neutralizes JWT-based `extractAccountId` in `pi-ai`'s codex provider —
   cells ship the proxy secret as bearer (not a JWT), so the original
   function would throw. Mother adds the real `chatgpt-account-id` header
   server-side. Idempotent.

Use local `bash`:

```bash
scripts/configure-cell-proxy.sh <NAME>
```

This runs after `bun install` (step 5) so the model files exist. If the
cell ever runs `bun install` again, this script must be re-run — both
patches will be clobbered and the cell will start hitting upstream APIs
directly with the proxy secret (which both providers reject). Also re-run
if you rotate `CELLS_PROXY_SECRET`.

Background: see `state/memory/project_mother_proxy.md` and
`state/memory/reference_pi_internals.md` for why this is necessary.

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

The script reads `SPRITES_TOKEN` from `~/.cells/secrets.json` and PUTs a
service that runs `tmux new-session -dA -s <NAME> pi` plus a wait loop.
The loop keeps the service process alive while the tmux session exists,
so Sprites considers the service "running" and doesn't restart it
unnecessarily.

## 7b. Register the `site` service + open the cell URL to mother

The cell's public face at `<NAME>.cells.md` is served by the cell itself,
not mother — `~/agent/site/server.ts` is a tiny Bun web server that the
cell owns and can morph (drop `public/index.html`, add routes, swap the
whole thing for a different framework). Mother just reverse-proxies.

Two pieces:

1. **Flip the sprite URL to `--auth=public`.** By default the sprite URL
   `<name>-XXX.sprites.app` redirects unauthenticated traffic to a
   sprites.dev login. Mother can't carry the org-token cookie through a
   reverse proxy, so we open the URL. Security still holds because the
   site server requires `x-mother-secret` (set in step 6c), and mother
   is the only thing that knows it.

   ```bash
   sprite url update --auth public -s <NAME>
   ```

2. **Register the `site` service.** Same shape as `agent` in step 7;
   supervises `bun run server.ts` with `CELL_NAME` and `PORT=8080` set:

   ```bash
   scripts/register-site-service.sh <NAME>
   ```

After both, `cells see <NAME>` should open `<NAME>.cells.md` in the
browser and render the cell's homepage.

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
  exec tmux new-session -A -s <NAME> pi
fi
EOF

cat >> /home/sprite/.zshrc << 'EOF'

# agent: source bashrc.d for env (PATH, ANTHROPIC_AUTH_TOKEN, etc)
for f in /home/sprite/.bashrc.d/*; do source $f; done

# agent: auto-attach to Pi TUI on interactive login
if [[ -z "$TMUX" && -t 0 ]]; then
  cd /home/sprite/agent
  exec tmux new-session -A -s <NAME> pi
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

Log the birth event by appending one line to `state/memory/project_cells_activity.md`:

`<UTC date HH:MM>  born        <NAME>      <terse notes>`

Use `date -u +"%Y-%m-%d %H:%M"` for the timestamp.

## 12. Tell the user

After reporting outcome, tell the user one line:

> Agent `<NAME>` is alive. Talk to it with `cells talk <NAME>`.

No caveats, no warnings, no future-state notes. Just the success line.

## On failure

Stop at the first failed step. Skip ahead to step 10 with `success: false`
and a message describing what broke. Don't record in memory (step 11) on
failure. Don't try to recover automatically.
