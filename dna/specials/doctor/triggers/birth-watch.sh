#!/usr/bin/env bash
# birth-watch — watch the lifecycle of `cells birth` procs on the Mac.
#
# Emits one line per state transition (debounced via state files):
#   parallel-birth count=N pids=...
#   birth-hang     pid=X elapsed=Ys
#   birth-exited   pid=X duration=Ys
#
# `birth-hang` and `parallel-birth` are the [[feedback_parallel_mother_failure_mode]]
# / [[project_mother_concurrency]] family — silent deadlocks that look like a
# hung LLM.  `birth-exited` is a "go look" signal — the doctor agent checks
# whether the post-exit fleet state is sane.
#
# Designed to be `tail -f`-shaped: one line per event on stdout, runs forever.

set -u

STATE_DIR="${DOCTOR_STATE:-${HOME}/.cells/doctor/state}"
mkdir -p "$STATE_DIR"

TRACKED="$STATE_DIR/birth-pids"            # lines: "pid start_epoch"
HANG_FLAGS="$STATE_DIR/birth-hang-flags"   # space-separated pids already reported as hung
PAR_FLAG="$STATE_DIR/birth-parallel-flag"  # last emitted parallel signature

touch "$TRACKED" "$HANG_FLAGS" "$PAR_FLAG"

HANG_THRESHOLD_S=${BIRTH_HANG_THRESHOLD_S:-180}
TICK_INTERVAL_S=${BIRTH_WATCH_INTERVAL_S:-15}

emit() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

while true; do
  current=$(pgrep -f 'cells\.ts.*\bbirth\b' 2>/dev/null | sort -u | tr '\n' ' ')
  current=${current% }
  now=$(date +%s)

  # ── Parallel detection ────────────────────────────────────────────────
  count=$(printf '%s' "$current" | wc -w | tr -d ' ')
  par_key=""
  if [ "$count" -ge 2 ]; then
    par_key="$count|$current"
  fi
  prev_par=$(cat "$PAR_FLAG" 2>/dev/null || true)
  if [ "$par_key" != "$prev_par" ]; then
    if [ -n "$par_key" ]; then
      emit "parallel-birth count=$count pids=$current"
    fi
    printf '%s' "$par_key" > "$PAR_FLAG"
  fi

  # ── Lifecycle scan ────────────────────────────────────────────────────
  tmp=$(mktemp "$STATE_DIR/birth-pids.tmp.XXXXXX")
  hang_flags=$(cat "$HANG_FLAGS" 2>/dev/null || true)
  new_hang_flags=""

  if [ -s "$TRACKED" ]; then
    while IFS=' ' read -r pid start; do
      [ -z "$pid" ] && continue
      if printf ' %s ' "$current" | grep -q " $pid "; then
        # Still running
        elapsed=$((now - start))
        printf '%s %s\n' "$pid" "$start" >> "$tmp"
        if [ "$elapsed" -gt "$HANG_THRESHOLD_S" ]; then
          if ! printf '%s' "$hang_flags" | grep -qw "$pid"; then
            emit "birth-hang pid=$pid elapsed=${elapsed}s"
          fi
          new_hang_flags="$new_hang_flags $pid"
        fi
      else
        # Exited (gone from pgrep)
        duration=$((now - start))
        emit "birth-exited pid=$pid duration=${duration}s"
      fi
    done < "$TRACKED"
  fi

  # New births (untracked pids → record start, no emit)
  for pid in $current; do
    [ -z "$pid" ] && continue
    if ! grep -q "^${pid} " "$TRACKED" 2>/dev/null; then
      printf '%s %s\n' "$pid" "$now" >> "$tmp"
    fi
  done

  mv "$tmp" "$TRACKED"
  printf '%s' "$new_hang_flags" > "$HANG_FLAGS"

  sleep "$TICK_INTERVAL_S"
done
