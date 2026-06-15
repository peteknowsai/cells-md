#!/bin/bash
# interactive-claude-job.sh — run a cells job through a GENUINELY INTERACTIVE
# Claude Code session (not `claude --print`), so the request carries
# cc_entrypoint=cli and bills the interactive subscription pool instead of the
# metered Agent-SDK credit (see docs/proposals/jobs.html → interactive mode,
# and the cc_entrypoint billing split, 2026-06-15).
#
# Mechanism (proven on delta-market 2026-06-15):
#   - tmux provides the PTY (it answers the DA1/DA2/DSR capability queries the
#     Ink TUI issues at startup — a raw pipe would hang; this is why we don't
#     just drop --print). A DEDICATED `tmux -L` socket per job keeps the server
#     inside the job's systemd-unit cgroup, so `systemctl kill <unit>` reaps it.
#   - inline --settings registers two hooks: SessionStart → ready marker (boot
#     past the trust + bypass dialogs), Stop → capture payload + done marker
#     (DETERMINISTIC completion — no spinner scraping).
#   - the prompt is injected via tmux bracketed-paste (robust for multi-line /
#     special-char prompts), submitted with Enter.
#   - the answer is recovered from the session TRANSCRIPT JSONL (path from the
#     Stop payload — mode-agnostic, works for fresh and forked sessions) and
#     re-emitted as the same stream-json {assistant, result} frames `claude -p`
#     would have produced, so extractJobResult() in lib/jobs.ts is unchanged.
#
# This script OWNS its out/err/exit files (unlike the --print path where the
# bash wrapper redirects them): out gets liveness pane-snapshots during the run
# (byte growth keeps the watchdog from false-stalling) plus the reconstructed
# frames at the end; err gets claude's real stderr; exit gets the verdict code.
set -u

ID=""; JOBSDIR="/root/state/jobs"; PROMPT=""; OUT=""; ERR=""; EXIT=""
TARGET="fresh"; MAIN_SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID="$2"; shift 2;;
    --jobsdir) JOBSDIR="$2"; shift 2;;
    --prompt) PROMPT="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --err) ERR="$2"; shift 2;;
    --exit) EXIT="$2"; shift 2;;
    --target) TARGET="$2"; shift 2;;
    --main-sid) MAIN_SID="$2"; shift 2;;
    *) shift;;
  esac
done

cd /root
PROJ=/root/.claude/projects/-root
SOCK="cell-job-$ID"
READY="$JOBSDIR/$ID.ready"; DONE="$JOBSDIR/$ID.done"
SS="$JOBSDIR/$ID.ss.json"; STOP="$JOBSDIR/$ID.stop.json"
LAUNCH="$JOBSDIR/$ID.launch.sh"
: > "$OUT"; : > "$ERR"
rm -f "$READY" "$DONE" "$SS" "$STOP"

# Always leave nothing behind: kill the dedicated tmux server, drop its socket
# file (kill-server leaves it), and remove the internal markers.
cleanup(){
  tmux -L "$SOCK" kill-server 2>/dev/null
  rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SOCK" "$READY" "$DONE" "$SS" "$STOP" "$LAUNCH"
}
trap cleanup EXIT

fail(){ echo "$1" >> "$ERR"; echo "${2:-1}" > "$EXIT"; exit 0; }

# --- session flags by target ---------------------------------------------
# fresh: brand-new session, no context. fork: inherit main read-only, write to
# a NEW forked session (main untouched). main: continue main (single-owner —
# the runner supports it but the detached jobs path should not route here while
# the persistent talk process holds main open).
SESSION_ARGS=()
case "$TARGET" in
  fresh)
    SESSION_ARGS=(--session-id "$(cat /proc/sys/kernel/random/uuid)") ;;
  fork)
    [ -z "$MAIN_SID" ] && MAIN_SID="$(cat /root/.cell/claude-main-session 2>/dev/null)"
    if [ -z "$MAIN_SID" ] || [ ! -f "$PROJ/$MAIN_SID.jsonl" ]; then
      echo "[interactive-job] no main session to fork — falling back to fresh" >> "$ERR"
      SESSION_ARGS=(--session-id "$(cat /proc/sys/kernel/random/uuid)")
    else
      # --fork-session: inherit main's context, write to a NEW forked session
      # (main untouched). claude generates the fork id; we recover it from the
      # Stop hook payload, not from --session-id.
      SESSION_ARGS=(--resume "$MAIN_SID" --fork-session)
    fi ;;
  main)
    # main is single-owner: the persistent talk process holds it open. A
    # detached `--resume main` job would be a SECOND writer and could
    # corrupt/wedge the cell's main conversation. Refuse — main-target work must
    # route through the persistent channel (phase 2), not this path.
    fail "[interactive-job] --session main is not supported on the detached jobs path (main is single-owner; a detached --resume main would corrupt the live conversation). Use fresh or fork." 2 ;;
  *) fail "[interactive-job] unknown target: $TARGET" 2 ;;
esac

# --- pre-seed folder trust (idempotent belt; bake also seeds it) ----------
python3 - <<'PY' 2>/dev/null || true
import json
f="/root/.claude.json"
try: d=json.load(open(f))
except Exception: d={}
d.setdefault("projects",{}).setdefault("/root",{})["hasTrustDialogAccepted"]=True
json.dump(d,open(f,"w"))
PY

# --- inline hooks settings ------------------------------------------------
SETTINGS="$(python3 - "$READY" "$SS" "$STOP" "$DONE" <<'PY'
import json,sys
ready,ss,stop,done=sys.argv[1:5]
print(json.dumps({"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":f"cat > {ss}; touch {ready}"}]}],
 "Stop":[{"hooks":[{"type":"command","command":f"cat > {stop}; touch {done}"}]}]
}}))
PY
)"

# --- launch interactive claude in a dedicated tmux socket -----------------
# bypassPermissions: a job does real work headless; IS_SANDBOX satisfies the
# root guard; skipDangerousModePermissionPrompt (baked in settings.json)
# suppresses the one-time accept dialog. No --print → cc_entrypoint=cli.
{
  printf 'cd /root\n'
  printf 'exec env IS_SANDBOX=1 claude'
  for a in "${SESSION_ARGS[@]}"; do printf " %q" "$a"; done
  printf " --settings %q --permission-mode bypassPermissions\n" "$SETTINGS"
} > "$LAUNCH"

tmux -L "$SOCK" new-session -d -s job -x 200 -y 50 "bash $LAUNCH 2>>$ERR"

# --- wait for boot (SessionStart) -----------------------------------------
for _ in $(seq 1 60); do [ -f "$READY" ] && break; sleep 1; done
[ -f "$READY" ] || fail "[interactive-job] claude did not reach SessionStart within 60s" 1

# --- inject the prompt (bracketed paste = robust for any content) ---------
# Stamp the moment of submission: for a FORKED session the transcript is
# pre-seeded with main's history (including main's last assistant turn), so
# "last assistant row" is NOT necessarily this job's answer. We only accept
# assistant rows whose timestamp is at/after injection — this turn's rows.
rm -f "$DONE"
INJECT_EPOCH="$(date +%s)"
sleep 1
tmux -L "$SOCK" load-buffer -b jobp "$PROMPT"
tmux -L "$SOCK" paste-buffer -t job -b jobp -d -p
sleep 1
tmux -L "$SOCK" send-keys -t job Enter

# --- poll for completion; content-free liveness heartbeat -> err ----------
# The watchdog measures byte growth of out+err. We compare the rendered pane in
# memory but write only a CONTENT-FREE timestamp on change — never the pane
# text. A working TUI ticks its spinner/elapsed counter every second (the pane
# changes → a heartbeat → byte growth → alive); a truly wedged session freezes
# (no change → no heartbeat → the existing stall watchdog fires). Crucially, the
# pane can echo the submitted PROMPT, and on a failed job extractJobResult falls
# back to tailing the output — so pane content must never reach out/err (the
# "results never include the prompt" invariant). err also carries claude's real
# stderr, so a failed job still explains itself.
last=""
for _ in $(seq 1 21600); do            # generous; the systemd leash is the real bound
  [ -f "$DONE" ] && break
  cur="$(tmux -L "$SOCK" capture-pane -t job -p 2>/dev/null)"
  if [ "$cur" != "$last" ]; then printf 'live %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo tick)" >> "$ERR"; last="$cur"; fi
  sleep 3
done
[ -f "$DONE" ] || fail "[interactive-job] no Stop within budget" 1

# --- recover THIS turn's answer from the transcript -----------------------
# Transcript path from the Stop payload (authoritative; for a fork the id is
# generated post-launch, so SessionStart's path is the pre-fork one).
TP="$(python3 -c "import json;print(json.load(open('$STOP')).get('transcript_path',''))" 2>/dev/null)"
[ -z "$TP" ] && TP="$(python3 -c "import json;print(json.load(open('$SS')).get('transcript_path',''))" 2>/dev/null)"

# One pass that (a) polls up to ~12s for THIS turn's final assistant entry to
# flush (Stop can fire a beat before the write lands), filtering to rows
# at/after INJECT_EPOCH so inherited fork history is never mistaken for the
# answer, then (b) re-emits it + a synthesized result frame as the same
# stream-json extractJobResult() already parses (no consumer-side changes).
python3 - "$TP" "$INJECT_EPOCH" >> "$OUT" <<'PY'
import json, sys, os, time
from datetime import datetime
tp = sys.argv[1]
inj = float(sys.argv[2])
def ep(ts):
    try: return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except Exception: return 0.0
def this_turn_answer():
    rows = []
    if tp and os.path.exists(tp):
        for l in open(tp):
            l = l.strip()
            if l:
                try: rows.append(json.loads(l))
                except Exception: pass
    # Walk newest→oldest; accept only assistant rows from THIS turn (>= inject).
    for e in reversed(rows):
        if e.get("type") != "assistant" or ep(e.get("timestamp")) < inj:
            continue
        m = e.get("message", {})
        t = "".join(b.get("text", "") for b in m.get("content", []) if isinstance(b, dict) and b.get("type") == "text").strip()
        if t:
            return t, (m.get("stop_reason") or "")
    return "", ""
text, sr = "", ""
for _ in range(12):
    text, sr = this_turn_answer()
    if text: break
    time.sleep(1)
ok = bool(text) and sr in ("", "end_turn", "stop_sequence", "tool_use")
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}))
print(json.dumps({"type": "result", "subtype": "success" if ok else "error", "is_error": not ok, "result": text}))
PY

echo 0 > "$EXIT"
