// The body of /etc/profile.d/cells-env.sh — the cell's environment shim.
//
// Single source of truth, imported by cells.ts (bakeWriteProfileD at bake
// time, refreshShellNiceness at `cells shell` time, provisioning at birth).
// Pure data (no logic, no IO) so it imports into a test without running the
// CLI — see cells-env.test.ts, which runs the rendered shim under bash to
// prove the app-secret sourcing block actually exports a secret.
//
// Escaping note: this is a TS template literal, so `\$` renders to a literal
// `$` and `\`` to a backtick. The rendered string is what gets written to the
// cell, byte-for-byte.

export const CELLS_ENV_SH_BODY = `# /etc/environment carries CELLS_PROXY_SECRET (welld writes it when the
# well is created). PAM loads it for interactive login sessions — but
# systemd services (the site supervisor) and the bash -lc children its
# agent-comms forkAndAsk spawns never go through PAM, so the secret would
# be missing there. Source it here so it's in scope wherever cells-env.sh
# is read, not just on PAM logins.
if [ -r /etc/environment ]; then
  set -a
  . /etc/environment
  set +a
fi

# cells-managed app secrets, set post-birth via \`cells secret set <cell> KEY\`.
# One file per secret under /etc/cells.secrets.d/ (root:root 0600); the file's
# raw content IS the value. Exported here so every shell, job, talk-fork, and
# the site supervisor (all source this shim) sees them — the durable form of
# "ship a scoped key to a running cell". Sourced BEFORE the proxy-secret block
# below so a substrate-managed name always wins over a colliding app key (the
# CLI also refuses to set reserved names, but order is the real guarantee).
if [ -d /etc/cells.secrets.d ]; then
  for _sf in /etc/cells.secrets.d/*; do
    [ -f "\$_sf" ] || continue
    _sk=\$(basename "\$_sf")
    export "\$_sk=\$(cat "\$_sf")"
  done
  unset _sf _sk
fi

# Re-export CELLS_PROXY_SECRET under the names pi-ai's auth dispatch +
# codex-proxy expect.
if [ -n "\${CELLS_PROXY_SECRET:-}" ]; then
  export ANTHROPIC_OAUTH_TOKEN="\$CELLS_PROXY_SECRET"
  export ANTHROPIC_AUTH_TOKEN="\$CELLS_PROXY_SECRET"
  export OPENAI_CODEX_API_KEY="\$CELLS_PROXY_SECRET"
  unset ANTHROPIC_API_KEY
fi
# /root/bin on PATH for the cells CLI. Bun is installed for root at
# /root/.bun (= \$HOME/.bun, since the agent runs as root) and also ships
# system-wide at /usr/local/bin/bun from ubuntu-base. /root/.local/bin is
# where the claude CLI installs itself — the claude-code harness and its
# agent-comms forkAndAsk shell out to \`claude\`, so it has to resolve on
# a plain login-shell PATH.
export PATH="\$HOME/.bun/bin:/root/bin:/root/.local/bin:\$PATH"

# Cell identity. The substrate hostname is the well's egg-id (e.g.
# egg-403c69) — unfriendly and *not* the cell name. The real name is the
# first heading of the harness entrypoint: AGENTS.md (pi) or CLAUDE.md
# (claude-code/codex/hermes), sed'd in at birth. \`cells talk\` builds
# reply_to = https://\$CELL_NAME.cells.md/inbox/append from this, so every
# shell — including the non-interactive bash -lc that runs \`cells talk\` —
# must have CELL_NAME set, not just interactive tmux logins. Without this
# the reply routes to https://egg-XXXXXX.cells.md and 404s.
if [ -z "\${CELL_NAME:-}" ]; then
  CELL_NAME=\$(sed -n '1s/^# //p' /root/AGENTS.md 2>/dev/null)
  [ -z "\$CELL_NAME" ] && CELL_NAME=\$(sed -n '1s/^# //p' /root/CLAUDE.md 2>/dev/null)
  : "\${CELL_NAME:=\$(hostname)}"
  export CELL_NAME
fi

# Standard terminal-editing toolkit (apt-installed at bake: micro, fzf,
# ripgrep, batcat). FZF gitignore-aware via ripgrep, preview via bat.
# The two helpers below — \`mf\` (pick one + open in micro) and \`mft\`
# (browse mode: descend folders, open files, .. to go up) — are the
# "scroll through files with live preview" UX. Designed to be obvious
# from the keyboard, no vim ninja required.
export FZF_DEFAULT_COMMAND='rg --files --hidden --glob "!.git"'
export FZF_DEFAULT_OPTS='--height 80% --reverse --border --preview "batcat --style=numbers --color=always --line-range=:300 {} 2>/dev/null || ls -la {}" --preview-window=right:60%'

alias mf='f=\$(fzf) && [ -n "\$f" ] && micro "\$f"'

mft() {
  local cur="\$PWD"
  while true; do
    local pick
    pick=\$( { echo ".."; ls -A1 "\$cur"; } | fzf --prompt="\$cur > " ) || return
    if [ "\$pick" = ".." ]; then
      cur=\$(dirname "\$cur")
    elif [ -d "\$cur/\$pick" ]; then
      cur="\$cur/\$pick"
    else
      micro "\$cur/\$pick"
      return
    fi
  done
}

# Niceness for interactive tmux shells (i.e. cells shell <name>): a
# violet prompt with the cell's name + a one-shot welcome banner per
# pane. Skips one-off well_exec commands (no \$PS1, no \$TMUX) so
# automation stays quiet. CELL_NAME is already resolved + exported above.
if [ -n "\${PS1:-}" ] && [ -n "\${TMUX:-}" ]; then
  export PS1="\\[\\e[38;5;141m\\]\${CELL_NAME}\\[\\e[0m\\] \\w \\\$ "
  _banner_marker="/tmp/.cells-banner-\${TMUX_PANE//[^A-Za-z0-9]/_}"
  if [ ! -f "\$_banner_marker" ]; then
    touch "\$_banner_marker" 2>/dev/null || true
    echo
    echo "🧬 \${CELL_NAME}"
    echo "   /root              anatomy (AGENTS.md, SOUL.md, …)"
    echo "   /root/state/memory persistent memory"
    echo "   cells, well        fleet + substrate CLIs"
    echo "   mf, mft            fuzzy-pick / browse files with live preview"
    echo "   Ctrl-d             exit this shell"
    echo
  fi
  unset _banner_marker
fi
`;
