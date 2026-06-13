// Fleet transport probes — the in-well checks `cells doctor` runs so the
// doctor can no longer say "all green" while the fleet is mute. Born from
// the 2026-06-09/10 incident: mother ran 18 days with a welld service
// definition but no in-guest unit (replies dropped on the floor), bob woke
// with an 18-day-stale clock and a supervisor OOM-killed mid-conversation —
// and doctor saw none of it, because every existing check stops at the Mac.
//
// Pure logic (script text, output parsing, classification) is separated
// from IO — the caller (cmdDoctor) runs the script via `well exec` and
// feeds the raw output back here. Mirrors the registry.ts / fleet.ts split.

// One round-trip per running well: emits a single JSON line prefixed with
// CELLPROBE so the parser can find it amid login-shell noise. Every field
// is best-effort — a missing tool degrades that field, not the probe.
//   unit_present  the systemd unit file exists (catches def-vs-guest drift)
//   unit_active   systemctl is-active well-site
//   health        the supervisor's localhost:8080/health body ("ok" when up)
//   oom_48h       oom-kill count for the unit in the last 48h of journal
//   epoch         guest clock, seconds — compared Mac-side for skew
//   jobs_running  job-lane records in status "running" (jobs lane,
//                 docs/proposals/jobs.html)
//   jobs_stale    running jobs whose output hasn't grown in >10 min —
//                 watchdog-should-have-fired territory (runner dead?)
export const GUEST_PROBE_SCRIPT = `
UA=$(systemctl is-active well-site 2>/dev/null || true)
UP=false; [ -f /etc/systemd/system/well-site.service ] && UP=true
H=$(curl -sS -m 2 http://localhost:8080/health 2>/dev/null || true)
OOM=$(journalctl -u well-site --since "-48 hours" 2>/dev/null | grep -c oom-kill || true)
NOW=$(date +%s)
JR=0; JS=0
if [ -d /root/state/jobs ]; then
  for M in /root/state/jobs/*.json; do
    [ -f "$M" ] || continue
    grep -q '"status": *"running"' "$M" || continue
    JR=$((JR+1))
    ID=$(basename "$M" .json)
    # Newest mtime across out AND err — the watchdog treats either growing
    # as progress, so a job that logs only to stderr must not read stale.
    NEWEST=0
    for F in "/root/state/jobs/$ID.out.jsonl" "/root/state/jobs/$ID.err"; do
      [ -f "$F" ] || continue
      MT=$(stat -c %Y "$F" 2>/dev/null || echo 0)
      [ "$MT" -gt "$NEWEST" ] && NEWEST=$MT
    done
    AGE=$(( NOW - NEWEST ))
    [ "$AGE" -gt 600 ] && JS=$((JS+1))
  done
fi
echo "CELLPROBE {\\"unit_active\\":\\"$UA\\",\\"unit_present\\":$UP,\\"health\\":\\"$H\\",\\"oom_48h\\":\${OOM:-0},\\"epoch\\":\${NOW:-0},\\"jobs_running\\":\${JR:-0},\\"jobs_stale\\":\${JS:-0}}"
`.trim();

export type GuestProbe = {
  unit_active: string; // "active" | "inactive" | "failed" | "" (unit unknown)
  unit_present: boolean;
  health: string; // "ok" when the supervisor answered
  oom_48h: number;
  epoch: number;
  jobs_running: number;
  jobs_stale: number;
};

export function parseGuestProbe(raw: string): GuestProbe | null {
  const line = raw.split("\n").find((l) => l.includes("CELLPROBE"));
  if (!line) return null;
  const json = line.slice(line.indexOf("CELLPROBE") + "CELLPROBE".length).trim();
  try {
    const p = JSON.parse(json);
    return {
      unit_active: String(p.unit_active ?? ""),
      unit_present: p.unit_present === true,
      health: String(p.health ?? ""),
      oom_48h: Number(p.oom_48h) || 0,
      epoch: Number(p.epoch) || 0,
      jobs_running: Number(p.jobs_running) || 0,
      jobs_stale: Number(p.jobs_stale) || 0,
    };
  } catch {
    return null;
  }
}

export type TransportVerdict = {
  status: "ok" | "warn" | "fail";
  reasons: string[];
};

export const CLOCK_SKEW_WARN_S = 300;

// Classify one cell's transport health from what we could observe.
//   defPresent  welld has a `site` service definition for the cell's well
//   power       welld's view: running / hibernated / unknown
//   guest       in-guest probe result (null when not probed: hibernated
//               wells aren't woken for a doctor run, and exec can fail)
//   macEpochS   Mac clock at probe time, for skew comparison
export function classifyCellTransport(input: {
  defPresent: boolean;
  power: "running" | "hibernated" | "unknown";
  guest: GuestProbe | null;
  macEpochS: number;
}): TransportVerdict {
  const reasons: string[] = [];
  let status: TransportVerdict["status"] = "ok";
  const fail = (r: string) => {
    status = "fail";
    reasons.push(r);
  };
  const warn = (r: string) => {
    if (status !== "fail") status = "warn";
    reasons.push(r);
  };

  if (!input.defPresent) {
    // No definition at all — replies will never route, awake or asleep.
    fail("no `site` service definition in welld — talk replies cannot route");
    return { status, reasons };
  }

  if (input.power === "hibernated") {
    // Asleep with a definition: nothing more is observable without waking.
    return { status: "ok", reasons: [] };
  }

  if (input.power === "unknown") {
    warn("welld has no power state for this well");
    return { status, reasons };
  }

  // Running — the guest probe is expected to have run.
  const g = input.guest;
  if (!g) {
    warn("running but in-guest probe failed (exec error?)");
    return { status, reasons };
  }
  if (!g.unit_present) {
    // The mother-class drift: definition in welld, nothing in the guest.
    fail("service def exists but well-site unit missing in guest — re-run register-site-service.sh");
  } else if (g.unit_active !== "active") {
    fail(`well-site unit is ${g.unit_active || "unknown"}`);
  } else if (g.health !== "ok") {
    fail("supervisor :8080/health not answering — talk replies will drop");
  }
  if (g.oom_48h > 0) {
    warn(`${g.oom_48h} oom-kill(s) of well-site in 48h — RAM too tight for this cell`);
  }
  if (g.jobs_stale > 0) {
    // The watchdog kills a stalled job inside ~5-10 min; output silent past
    // 10 min means the watchdog itself isn't firing (runner dead, interval
    // wedged) — the 23h-invisible class the jobs lane exists to prevent.
    warn(`${g.jobs_stale} running job(s) with no output >10min — jobs watchdog may be dead`);
  }
  if (g.epoch > 0) {
    const skew = Math.abs(g.epoch - input.macEpochS);
    if (skew > CLOCK_SKEW_WARN_S) {
      warn(`guest clock skewed ${skew}s from Mac — pre-makestep egg, chrony can't step it`);
    }
  }
  return { status, reasons };
}
