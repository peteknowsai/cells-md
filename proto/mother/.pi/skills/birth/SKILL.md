---
name: birth
description: Provision a new agent on a fresh Sprite. Creates the VM, configures egress, installs runtime tools, pushes the recipe-compliant DNA, runs `bun install`, injects the OAuth token, installs the login shim, and takes the first checkpoint.
allowed-tools: [bash, sprite_create, sprite_destroy, sprite_exec, sprite_push, sprite_egress_allow, sprite_checkpoint, report_outcome, read]
---

# Birth Ritual — Phase 0

Bring a new agent into being on a fresh Sprite. The agent's name is in the
user's message; substitute it for `<NAME>` in every step below.

Every step matters — if you shortcut, the agent silently lands on extra-usage billing.

Prefer the sprite_* tools for every step that has them — they're cleaner than
shell-out and surface errors as structured tool results. The `bash` tool is
still available for local-only operations on the Mac (e.g., reading
`~/.cells/secrets.json`).

## Preconditions

- `sprite` CLI authenticated (verify with `sprite org list`)
- `~/.cells/secrets.json` contains `CELLS_PROXY_SECRET` (the bearer token cells use to reach the subscriptions proxy at `https://proxy.cells.md`)
- No existing agent with this name (the Bun CLI checks before invoking you)
- All `bash scripts/...` invocations in this skill are relative to the cells repo root (`~/Projects/cells`). `cd` there before running them, or prefix each call with `cd ~/Projects/cells &&`.

## 1. Create the Sprite

Use `sprite_create` with `name: <NAME>`. Blocks ~15s until ready.

## 2. Configure egress (allow all)

Use `sprite_egress_allow` with `name: <NAME>` and `domains: ["*"]`. This opens
outbound to any host so the agent can research, fetch, and install freely.

Don't proceed until this succeeds — every later step depends on egress.

## 3. Install system tools and configure tmux

Bun is not pre-installed on Sprite VMs. tmux often is, but install/upgrade
it to be safe — useful for interactive shell sessions. (In v2 pi runs
under the site service, not in a tmux session, but tmux remains handy
for keeping side shells alive across sprite console reconnects.)

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

Use `sprite_exec` for the curl installs and tmux config (these don't have
sharp edges — they're idempotent and fast):

```bash
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://sprites.dev/install.sh | sh
# gh CLI — required by pi's /share (it shells out to `gh gist create`).
# Tarball install avoids the GitHub apt-repo dance and dpkg-lock exposure.
# Auth happens via GH_TOKEN injected in step 6b — `gh auth status` honors it
# natively, so no interactive `gh auth login` is needed.
GH_VERSION=2.62.0
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
  | sudo tar -xz -C /usr/local --strip-components=1 \
    "gh_${GH_VERSION}_linux_amd64/bin/gh"
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

# Forward mouse-wheel events to the running TUI when it's in alternate
# screen mode (pi-tui, vim, less). Without this, tmux's default
# WheelUpPane binding auto-enters copy-mode on the first wheel event,
# which steals keyboard focus from pi and lights up the whole pane.
bind -T root WheelUpPane   if-shell -F -t= '#{?pane_in_mode,1,#{alternate_on}}' 'send-keys -M' 'select-pane -t=; copy-mode -e; send-keys -M'
bind -T root WheelDownPane if-shell -F -t= '#{?pane_in_mode,1,#{alternate_on}}' 'send-keys -M' 'send-keys -M'

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

# Status line — solid color bar in the cell's color across the bottom.
set -g status-position bottom
set -g status-justify left
set -g status-style 'fg=__CELL_FG__,bg=__CELL_BG__,bold'
set -g status-left ' __NAME__ '
set -g status-left-length 20
set -g status-right ' #(/home/sprite/agent/bin/cell-status.sh) '
set -g status-right-length 60
set -g status-interval 5
setw -g window-status-format ''
setw -g window-status-current-format ''
setw -g window-status-separator ''

set -g pane-border-lines single
set -g pane-border-style 'fg=#54546D'
set -g pane-active-border-style 'fg=#957FB8'

setw -g mode-style 'fg=#1F1F28,bg=#7E9CD8'

# Bell notifications: Pi rings the terminal bell when a response is ready.
# bell-action other = flash only when the window isn't currently focused.
setw -g monitor-bell on
set -g bell-action other
setw -g window-status-bell-style 'fg=#C8C093,dotted-underscore'
EOF
ls -la /home/sprite/.bun/bin/bun
```

Then install the apt baseline using the helper script (laptop-side, **not**
`sprite_exec`). It handles dpkg-lock contention deterministically — if the
lock is held, it waits 30s, then force-unlocks once and retries. Without
this, a transient network blip mid-`apt-get` can leave the lock pinned for
~15 minutes.

```bash
bash scripts/apt-install-on-cell.sh <NAME> tmux micro fzf ripgrep bat
```

Before moving on, verify every required binary is on PATH on the sprite:
`sprite_exec`-run `command -v bun tmux micro fzf rg batcat gh` and confirm
all seven print a path. If any are missing, re-run only the substep that
provided that binary; do not proceed to step 4.

**Recovery posture for the whole birth:** if any single sub-operation fails
twice, *stop and surface the error to Pete* with the specific command and
stderr. Do not enter ad-hoc retry loops. Birth is rare enough that a quick
hard-fail is always better than a slow silent one.

## 4. Push the agent DNA

Mother's `dna/` directory (at `proto/mother/dna/`) contains the canonical
recipe-compliant layout — the genetic material every cell is born with.
The agent's "anatomy" is sharded into single-purpose markdown files at the
agent root, each independently editable:

- `AGENTS.md` — thin entrypoint (cross-harness convention)
- `SOUL.md` — identity + behavior (the use-max systemPrompt source)
- `CELLS.md` — what it means to be a cell (substrate awareness)
- `TOOLS.md` — capability inventory
- `CONTACTS.md` — who the cell interacts with
- `MEMORY.md` — pointer to `state/memory/`
- `HEARTBEAT.md` — declared schedule (future heartbeat agent enforces)
- `IDENTITY.md` — metadata for tooling

Plus `.pi/extensions/use-max`, `.pi/settings.json`, `package.json`,
`.gitignore`, `bin/`, `scripts/`, `site/`.

Use `sprite_push` with:
- `name: <NAME>`
- `localPath: /Users/pete/Projects/cells/proto/mother/dna`
- `remotePath: /home/sprite/agent`

Then substitute `__NAME__`, `__MODEL__`, `__PROVIDER__`, and `__THINKING__`
with their actual values. Use `sprite_exec`:

```bash
sed -i 's/__NAME__/<NAME>/g' \
  /home/sprite/agent/AGENTS.md \
  /home/sprite/agent/SOUL.md \
  /home/sprite/agent/IDENTITY.md \
  /home/sprite/agent/CELLS.md \
  /home/sprite/agent/CONTACTS.md \
  /home/sprite/agent/HEARTBEAT.md \
  /home/sprite/agent/package.json

sed -i 's/__MODEL__/<MODEL>/g' \
  /home/sprite/agent/SOUL.md \
  /home/sprite/agent/IDENTITY.md \
  /home/sprite/agent/.pi/settings.json

sed -i 's/__PROVIDER__/<PROVIDER>/g' \
  /home/sprite/agent/IDENTITY.md \
  /home/sprite/agent/.pi/settings.json

sed -i 's/__THINKING__/<THINKING>/g' /home/sprite/agent/.pi/settings.json
```

### 4b. Per-cell tmux color chip

The DNA's `~/.tmux.conf` ships with `__CELL_FG__` / `__CELL_BG__`
placeholders in the `status-left-style` line. Compute the color
locally and substitute them on the cell:

```bash
# Locally on the Mac (use bash, NOT sprite_exec):
read CBG CFG < <(bash scripts/cell-color.sh <NAME>)

# Then sprite_exec to substitute on the cell. Also bake the cell name
# into the status-left chip so the bar reads the cell name regardless of
# which tmux session you're attached to (tui, shell, etc.).
sed -i "s|__CELL_BG__|$CBG|g; s|__CELL_FG__|$CFG|g; s|__NAME__|<NAME>|g" /home/sprite/.tmux.conf
```

`scripts/cell-color.sh` is deterministic — same name always maps to the
same palette entry — so retrofits and re-births stay stable.

### 4c. Write the cell's status file

The right side of the tmux bar reads `~/agent/.pi/status.json`. Write
it now with the harness baked in and channels empty (the laptop's slack
binding code populates `channels` later if a slack channel is bound):

```bash
mkdir -p /home/sprite/agent/.pi
cat > /home/sprite/agent/.pi/status.json <<'EOF'
{
  "harness": "<HARNESS>",
  "channels": []
}
EOF
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

The DNA ships with `bin/cells` — a slim on-sprite CLI (read+talk only,
backed by the Sprites HTTP API). Make it executable and symlink onto PATH
so both the agent's bash and the `self` extension can call it.

First, prune the in-tree optional extensions the user did NOT pick. The
DNA ships with all four (`memory`, `mentality`, `wiki`, `dream`) under
`/home/sprite/agent/.pi/extensions/`; we keep only those listed in
`<EXTENSIONS>` and delete the rest.

The always-installed extensions (`use-max`, `self`, `heartbeat-watch`)
stay regardless. Slack delivery is handled by the v2 bridge (the
per-cell Cloudflare Worker + the cell's site server's WebSocket
endpoint), not by any in-pi extension.

For each name in `["memory", "mentality", "wiki", "dream"]` that is NOT
in `<EXTENSIONS>`, delete the directory via `sprite_exec`:

```bash
rm -rf /home/sprite/agent/.pi/extensions/<name>
```

If `<EXTENSIONS>` is `["memory", "wiki"]`, delete the other two.
If `<EXTENSIONS>` is empty, delete all four.

Then **register the chosen optional extensions in `.pi/settings.json`**.
The DNA template's `extensions` array only lists the always-installed
ones (`use-max`, `codex-proxy`, `self`, `thinking`, `heartbeat-watch`).
Pi loads only what's in this array — leaving an extension on disk
without registering it does nothing. For each name in `<EXTENSIONS>`,
append `.pi/extensions/<name>/index.ts` via `sprite_exec`:

```bash
jq --arg p ".pi/extensions/<name>/index.ts" \
  '.extensions += [$p]' /home/sprite/agent/.pi/settings.json \
  > /tmp/s.json && mv /tmp/s.json /home/sprite/agent/.pi/settings.json
```

If `<EXTENSIONS>` is empty, skip this step.

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

The optional in-tree extensions:

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
route through the subscriptions proxy and don't hold real Anthropic credentials.
The legacy approach was to push a frozen OAuth access token; it expired
hours after birth.

## 6c. Wire the cell to the subscriptions proxy

Cells reach both Anthropic (Claude Max) and OpenAI Codex (ChatGPT Plus)
via `https://proxy.cells.md`, which the mother laptop runs as the single
OAuth principal for both subscriptions across the whole fleet.

This step runs unconditionally — including for direct-API cells (e.g.
`deepseek`, `openai` non-codex). The proxy env files (`anthropic_proxy`,
`codex_proxy`) and pi patches (Anthropic URL rewrite, codex
extractAccountId stub) are harmless on those cells: pi-ai only consults
the env var for its active provider, and the patched code paths are
never executed when `defaultProvider` is something else.

This step does five things:

1. Drops `~/.bashrc.d/anthropic_proxy` with the shared bearer secret
   (`CELLS_PROXY_SECRET` from `~/.cells/secrets.json`) as `ANTHROPIC_AUTH_TOKEN`.
2. Drops `~/.bashrc.d/codex_proxy` with the same secret as `OPENAI_CODEX_API_KEY`,
   read by the `codex-proxy` extension at pi startup.
3. Drops `~/.bashrc.d/site_proxy` with the same secret as `CELLS_PROXY_SECRET`,
   read by the cell's site server (`~/agent/site/server.ts`) and by the
   `heartbeat-watch` extension. The site server gates the `/agent`
   WebSocket upgrade on `Authorization: Bearer <CELLS_PROXY_SECRET>`;
   only the per-cell Cloudflare Worker (which knows the secret) can
   establish the bridge.
4. Patches the hardcoded `api.anthropic.com` URL in `pi-ai`'s model registry
   to `proxy.cells.md`. Pi does NOT respect `ANTHROPIC_BASE_URL` — the URL
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

## 7. Register the `site` service + open the cell URL to mother

The cell's public face at `<NAME>.cells.md` is served by the cell itself,
not mother — `~/agent/site/server.ts` is a tiny Bun web server that the
cell owns and can morph (drop `public/index.html`, add routes, swap the
whole thing for a different framework). Mother just reverse-proxies.

In v2, the site server is also the **pi host**: it spawns `pi --mode rpc`
as a child process and exposes a `/agent` WebSocket endpoint. The
per-cell Cloudflare Worker (deployed below if a Slack channel is bound)
holds a persistent outbound WebSocket to that endpoint and is the only
delivery path for inbound prompts and outbound replies. There is no
separate `agent` service and no tmux pi.

Two pieces:

1. **Flip the sprite URL to `--auth=public`.** By default the sprite URL
   `<name>-XXX.sprites.app` redirects unauthenticated traffic to a
   sprites.dev login. The per-cell Cloudflare Worker can't carry the
   org-token cookie, so we open the URL. Security still holds because the
   site server requires `Authorization: Bearer <CELLS_PROXY_SECRET>` on the
   `/agent` WS upgrade — the per-cell Worker is the only thing that knows
   the secret. Static HTTP routes (homepage, public/) are public.

   ```bash
   sprite url update --auth public -s <NAME>
   ```

2. **Register the `site` service.** Supervises `bun run server.ts`
   with `CELL_NAME` and `PORT=8080` set; the server itself spawns pi:

   ```bash
   scripts/register-site-service.sh <NAME>
   ```

The per-cell Cloudflare Worker (the `CellAgent` DO that holds the
persistent WS to the sprite) is deployed by the `cells` CLI itself
post-birth — not from inside the birth ritual — because it runs on
the Mac and depends on the sprite already existing. You don't need
to touch `deploy-cell-worker.sh` here.

After both pieces register, `cells see <NAME>` should open
`<NAME>.cells.md` in the browser and render the cell's homepage.

## 8. Login shim — env on interactive login

Sprite's interactive shell is **zsh** (despite `/etc/passwd` listing /bin/bash
as the login shell). zsh doesn't auto-source `.bashrc.d`, so we explicitly
source it from `.zshrc` so an interactive login has the same env (PATH,
ANTHROPIC_AUTH_TOKEN, CELLS_PROXY_SECRET, etc.) as the site service.

In v2 we **don't** auto-attach to a pi TUI on login. Pi runs as a child
of the site service (step 7); the cell speaks via the WebSocket bridge.
Logging in lands you in a normal zsh in `/home/sprite/agent` so you can
inspect logs, edit files, or run `pi --mode tui` manually against a
separate session if you want to drive pi interactively.

Use `sprite_exec`:

```bash
cat >> /home/sprite/.zshrc << 'EOF'

# agent: source bashrc.d for env (PATH, ANTHROPIC_AUTH_TOKEN, etc)
for f in /home/sprite/.bashrc.d/*; do source $f; done

# agent: drop into the agent dir on login
cd /home/sprite/agent
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
