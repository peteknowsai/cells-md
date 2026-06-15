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
  fork|main)
    [ -z "$MAIN_SID" ] && MAIN_SID="$(cat /root/.cell/claude-main-session 2>/dev/null)"
    if [ -z "$MAIN_SID" ] || [ ! -f "$PROJ/$MAIN_SID.jsonl" ]; then
      echo "[interactive-job] no main session for target=$TARGET — falling back to fresh" >> "$ERR"
      SESSION_ARGS=(--session-id "$(cat /proc/sys/kernel/random/uuid)")
    elif [ "$TARGET" = "fork" ]; then
      SESSION_ARGS=(--resume "$MAIN_SID" --fork-session)
    else
      SESSION_ARGS=(--resume "$MAIN_SID")
    fi ;;
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
rm -f "$DONE"
sleep 1
tmux -L "$SOCK" load-buffer -b jobp "$PROMPT"
tmux -L "$SOCK" paste-buffer -t job -b jobp -d -p
sleep 1
tmux -L "$SOCK" send-keys -t job Enter

# --- poll for completion; pane-change snapshots -> out for liveness -------
# capture-pane only appended when CHANGED: a working TUI ticks its spinner/
# elapsed counter every second (byte growth → alive); a truly wedged session
# freezes (no growth → the existing stall watchdog fires). Non-JSON lines are
# ignored by extractJobResult.
last=""
for _ in $(seq 1 21600); do            # generous; the systemd leash is the real bound
  [ -f "$DONE" ] && break
  cur="$(tmux -L "$SOCK" capture-pane -t job -p 2>/dev/null)"
  if [ "$cur" != "$last" ]; then printf '%s\n' "$cur" | tail -3 >> "$OUT"; last="$cur"; fi
  sleep 3
done
[ -f "$DONE" ] || fail "[interactive-job] no Stop within budget" 1

# --- recover the answer from the transcript (settle for the final flush) --
TP="$(python3 -c "import json;print(json.load(open('$STOP')).get('transcript_path',''))" 2>/dev/null)"
[ -z "$TP" ] && TP="$(python3 -c "import json;print(json.load(open('$SS')).get('transcript_path',''))" 2>/dev/null)"
# Stop can fire a beat before claude flushes the final assistant entry —
# poll briefly for it to appear rather than racing.
for _ in $(seq 1 10); do
  if python3 -c "
import json,sys
a=[json.loads(l) for l in open('$TP') if l.strip() and json.loads(l).get('type')=='assistant']
sys.exit(0 if a and ''.join(b.get('text','') for b in a[-1].get('message',{}).get('content',[]) if isinstance(b,dict) and b.get('type')=='text').strip() else 1)
" 2>/dev/null; then break; fi
  sleep 1
done

# Re-emit the final assistant + a synthesized result frame as stream-json,
# exactly what `claude -p --output-format stream-json` would tail — so
# extractJobResult() parses it with no special-casing.
python3 - "$TP" >> "$OUT" <<'PY'
import json,sys,os
tp=sys.argv[1]; rows=[]
if tp and os.path.exists(tp):
    for l in open(tp):
        l=l.strip()
        if l:
            try: rows.append(json.loads(l))
            except Exception: pass
asst=[e for e in rows if e.get("type")=="assistant"]
text=""; stop_reason=""
if asst:
    m=asst[-1].get("message",{})
    stop_reason=m.get("stop_reason") or ""
    text="".join(b.get("text","") for b in m.get("content",[]) if isinstance(b,dict) and b.get("type")=="text").strip()
ok = bool(text) and stop_reason in ("", "end_turn", "stop_sequence", "tool_use")
print(json.dumps({"type":"assistant","message":{"content":[{"type":"text","text":text}]}}))
print(json.dumps({"type":"result","subtype":"success" if ok else "error","is_error": not ok,"result":text}))
PY

echo 0 > "$EXIT"
