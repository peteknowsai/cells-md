#!/bin/bash
# interactive-claude-talk.sh — bootstrap ONE warm, long-lived, GENUINELY
# INTERACTIVE Claude Code talk session (not `claude --print`), so every turn
# carries cc_entrypoint=cli and bills the interactive subscription pool instead
# of the metered Agent-SDK credit (see docs/proposals/named-sessions.html and
# the cc_entrypoint billing split, 2026-06-15).
#
# This is the LONG-LIVED sibling of interactive-claude-job.sh. The job runner is
# per-turn: inject one prompt, wait for Stop, harvest, exit. A talk session is
# the opposite — it stays at the prompt across many turns, and the supervisor
# (site/server.ts) drives each turn: inject via tmux, tail the transcript JSONL
# live for output, close on the per-turn Stop marker. So this script does ONLY
# the bootstrap and then GETS OUT OF THE WAY:
#   - seed the boot gates (idempotent; same as the job runner),
#   - register the SessionStart/Stop hooks with PER-SESSION marker paths,
#   - launch claude in a dedicated `tmux -L cell-talk-<name>` socket,
#   - wait for SessionStart (ready), then EXIT 0 leaving the tmux SERVER alive.
# The supervisor injects every turn into that live pane and tails it. exit 0 =
# warm + ready; non-zero = bootstrap failed (the supervisor errors the turn).
#
# Mechanism notes (proven on the job runner): tmux provides the PTY (Ink's
# DA1/DA2/DSR capability queries would hang a raw pipe); the dedicated `-L`
# socket isolates this session's server so the supervisor can kill exactly it;
# the bypass-perms flag must be PERSISTED (it's ignored via inline --settings),
# so we seed it here.
set -u

NAME=""; SOCK=""; STATEDIR="/root/state/talk"; MODE="resume"; SID=""; TIMEOUT_MS=25000
MODEL=""; ROLE_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2;;
    --sock) SOCK="$2"; shift 2;;
    --statedir) STATEDIR="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;           # resume | create
    --sid) SID="$2"; shift 2;;             # claude session id to resume or assert
    --timeout-ms) TIMEOUT_MS="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;         # per-session claude model id (uniform-cell)
    --role-file) ROLE_FILE="$2"; shift 2;; # per-session role preamble → --append-system-prompt
    *) shift;;
  esac
done
case "$TIMEOUT_MS" in (*[!0-9]*|"") TIMEOUT_MS=25000 ;; esac
[ -n "$NAME" ] || { echo "[talk-bootstrap] missing --name" >&2; exit 2; }
[ -n "$SOCK" ] || SOCK="cell-talk-$NAME"
[ -n "$SID" ] || { echo "[talk-bootstrap] missing --sid" >&2; exit 2; }

cd /root
mkdir -p "$STATEDIR"
READY="$STATEDIR/$NAME.ready"
SS="$STATEDIR/$NAME.ss.json"
STOP="$STATEDIR/$NAME.stop.json"
DONE="$STATEDIR/$NAME.done"
ERR="$STATEDIR/$NAME.err"
LAUNCH="$STATEDIR/$NAME.launch.sh"
# Fresh bootstrap: clear this session's markers (a prior cold run may have left
# them). The supervisor also clears DONE before each turn.
rm -f "$READY" "$SS" "$STOP" "$DONE"
: > "$ERR"

# --- session flags by mode ------------------------------------------------
# resume: continue the durable per-name session (writes durably to its own id).
# create: first use — assert the supervisor-supplied uuid so it can be persisted
# to the registry before launch (no --fork-session; a named session is durable).
case "$MODE" in
  resume) SESSION_ARGS=(--resume "$SID") ;;
  create) SESSION_ARGS=(--session-id "$SID") ;;
  *) echo "[talk-bootstrap] bad --mode: $MODE" >&2; exit 2 ;;
esac

# --- pre-seed the boot gates (idempotent; verbatim from the job runner) ----
# A cell that has only ever run `claude --print` is NOT onboarded for an
# interactive session and blocks on dialogs before SessionStart fires:
#   - onboarding  → /root/.claude.json hasCompletedOnboarding
#   - folder trust → /root/.claude.json projects[/root].hasTrustDialogAccepted
#   - bypass accept → /root/.claude/settings.json skipDangerousModePermissionPrompt
# All must be PERSISTED (the bypass flag is ignored via inline --settings, and
# settings.json is a `cells refresh` protected path), so seed HERE. flock
# serializes concurrent session bootstraps + jobs; atomic temp+os.replace means
# a concurrent reader never sees a truncated file; we only write on change.
python3 - <<'PY' 2>/dev/null || true
import json, os, fcntl, tempfile
def atomic_write(path, obj):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".seed-")
    try:
        with os.fdopen(fd, "w") as f: json.dump(obj, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except Exception: pass
lk = open("/root/.claude/.seedlock", "w")
try:
    fcntl.flock(lk, fcntl.LOCK_EX)
    cj = "/root/.claude.json"
    try: d = json.load(open(cj))
    except Exception: d = {}
    proj = d.setdefault("projects", {}).setdefault("/root", {})
    if d.get("hasCompletedOnboarding") is not True or proj.get("hasTrustDialogAccepted") is not True:
        d["hasCompletedOnboarding"] = True
        proj["hasTrustDialogAccepted"] = True
        atomic_write(cj, d)
    sf = "/root/.claude/settings.json"   # augment only — never create/replace
    try: s = json.load(open(sf))
    except Exception: s = None
    if isinstance(s, dict) and s.get("skipDangerousModePermissionPrompt") is not True:
        s["skipDangerousModePermissionPrompt"] = True
        atomic_write(sf, s)
finally:
    fcntl.flock(lk, fcntl.LOCK_UN); lk.close()
PY

# --- inline hooks settings (PER-SESSION marker paths) ----------------------
# SessionStart → ready (once, at spawn). Stop → done (EVERY turn; the supervisor
# clears DONE before injecting and waits for it after). The marker paths embed
# the session name so concurrent sessions never collide.
SETTINGS="$(python3 - "$READY" "$SS" "$STOP" "$DONE" <<'PY'
import json,sys
ready,ss,stop,done=sys.argv[1:5]
print(json.dumps({"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":f"cat > {ss}; touch {ready}"}]}],
 "Stop":[{"hooks":[{"type":"command","command":f"cat > {stop}; touch {done}"}]}]
}}))
PY
)"

# --- launch interactive claude in a dedicated tmux socket ------------------
# Source cells-env.sh so claude sees the proxy bearer (the tmux server may not
# inherit the supervisor's full env). No --print → cc_entrypoint=cli.
{
  printf 'cd /root\n'
  printf '[ -r /etc/profile.d/cells-env.sh ] && . /etc/profile.d/cells-env.sh\n'
  printf 'exec env IS_SANDBOX=1 claude'
  for a in "${SESSION_ARGS[@]}"; do printf " %q" "$a"; done
  # Per-session model + role "hat" (uniform-cell). MODEL is a claude id (the
  # pool already translated the cells spec); the role text rides in a file so
  # free-text preambles can't break quoting — %q makes both shell-safe.
  [ -n "$MODEL" ] && printf ' --model %q' "$MODEL"
  if [ -n "$ROLE_FILE" ] && [ -r "$ROLE_FILE" ]; then
    printf ' --append-system-prompt %q' "$(cat "$ROLE_FILE")"
  fi
  printf " --settings %q --permission-mode bypassPermissions\n" "$SETTINGS"
} > "$LAUNCH"

# new-session -d daemonizes the tmux server: it survives this script exiting.
tmux -L "$SOCK" new-session -d -s talk -x 200 -y 50 "bash $LAUNCH 2>>$ERR"

# --- wait for boot (SessionStart) -----------------------------------------
# Poll in 1s steps up to the timeout. If claude dies during boot (auth/rate
# error) the tmux session vanishes — fail fast instead of waiting the full leash.
deadline=$(( TIMEOUT_MS / 1000 ))
[ "$deadline" -lt 1 ] && deadline=1
for _ in $(seq 1 "$deadline"); do
  [ -f "$READY" ] && exit 0
  tmux -L "$SOCK" has-session -t talk 2>/dev/null || {
    echo "[talk-bootstrap] claude exited during boot — see $ERR" >&2
    tmux -L "$SOCK" kill-server 2>/dev/null
    rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SOCK"
    exit 1
  }
  sleep 1
done

echo "[talk-bootstrap] claude did not reach SessionStart within ${deadline}s" >&2
tmux -L "$SOCK" kill-server 2>/dev/null
rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SOCK"
exit 1
