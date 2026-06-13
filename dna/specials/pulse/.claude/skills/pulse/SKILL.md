---
name: pulse
description: Run one pulse tick — drain the inbox, translate any new schedules into cron, refresh the digest. The unit of pulse's work; pulse runs this continuously.
allowed-tools: [bash, read, write]
---

# pulse — one tick

One pulse tick. Be terse — tool calls and one-line results, no prose, no
narration.

Every step is `node bin/pulse-core.mjs <command>`, run from your cell
root. Each command prints JSON. The only step that needs thinking is
step 2 (prose → cron) — everything else is deterministic.

**You no longer fire wakes.** Linux cron does. `save-schedule` writes
both `pulse-cache/<cell>.json` and the cell's block in
`/etc/cron.d/pulse-schedules`; the cron daemon evaluates that file every
minute and runs the `cells talk` lines. Your only job is keeping the
crontab in sync with each cell's HEARTBEAT.md.

## Steps

1. **Begin.** `node bin/pulse-core.mjs begin`
   - `skip:true` → a prior tick is still in flight. Stop now. Do **not**
     run `end` — the prior tick will.
   - `isFirstRun:true` → nothing extra to do; go to step 2. Seeding is
     **Mac-driven** — the proxy pushes each cell's HEARTBEAT.md into your inbox
     on every change, and the Mac re-seeds you on a project-pulse handoff.
     (`bootstrap` is a kept-for-compatibility no-op: you have no registry to
     walk, so just drain whatever you were handed.)

2. **Drain + translate.** `node bin/pulse-core.mjs drain` returns a JSON
   array of `{cell, content, path}` — only entries that need translating
   (unchanged re-pushes are auto-skipped). If it's `[]`, skip to step 3.

   For each entry, read `content` — a cell's HEARTBEAT.md prose — and
   turn it into a cron schedule, an array of `{cron, message}`:
   - `cron` is a 5-field crontab (`min hour dom mon dow`). **It is
     evaluated in your cell's local timezone (`America/Denver`, which
     handles MDT/MST DST natively).** Prose that says "local" means
     Mountain time — emit the local hour directly (`8am local` →
     `0 8 * * *`). Prose that explicitly says "UTC" must be converted:
     subtract 6 in MDT (Mar–Nov) or 7 in MST (Nov–Mar). Prefer the
     summer (MDT) offset and add a note in the message if the wake is
     timing-sensitive year-round (e.g. *"refresh at 9 UTC = 3am
     Mountain in summer / 2am winter"* → `0 3 * * *`).
   - `message` is the terse, second-person wake instruction sent to the
     cell — e.g. *"good morning — summarize today's calendar"*, not
     *"the user wants you to…"*.
   - Skip lines that are documentation, not schedule. Schedule prose has
     a time in it ("8am", "every weekday", "nightly", "every 15 min").
     A cell with no times has declared "no schedule" — save `[]` for it.

   Save each: pipe `{"cell":"<cell>","items":[…],"sourcePath":"<path>"}`
   to `node bin/pulse-core.mjs save-schedule`. The save updates the
   pulse-cache **and** rewrites the cell's block in
   `/etc/cron.d/pulse-schedules` in a single atomic step.

3. **Digest.** `node bin/pulse-core.mjs render` — refreshes the
   heartbeats digest (schedule + next-fire times only; cron owns the
   firing record).

4. **Dashboard.** `node bin/pulse-core.mjs render-dashboard` — rebuilds
   `~/site/public/index.html` so `pulse.cells.md` shows current status
   (last tick, active schedules, recent fires, inbox depth). The site
   server auto-publishes the change to the Worker.

5. **End.** `node bin/pulse-core.mjs end` — clears the sentinel, stamps
   the tick.

Stop after `end` returns. Don't summarize, don't echo the schedule.

## Notes

- Fires don't show up here anymore. To see what actually fired, tail
  `/root/.cells/logs/cron-fires.log` on the pulse cell.
- If `/etc/cron.d/pulse-schedules` ever drifts from the cache (manual
  edit, disk corruption), run `node bin/pulse-core.mjs sync-crontab` to
  rebuild it from `pulse-cache/`.
