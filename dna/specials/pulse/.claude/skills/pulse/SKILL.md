---
name: pulse
description: Run one pulse tick — drain the inbox, parse any new schedules, fire due wakes, render the digest. The unit of pulse's work; pulse runs this continuously.
allowed-tools: [bash, read, write]
---

# pulse — one tick

One pulse tick. Be terse — tool calls and one-line results, no prose, no
narration.

Every step is `node bin/pulse-core.mjs <command>`, run from your cell
root. Each command prints JSON. The only steps that need thinking are
step 2 (prose → cron) and step 4 (the daily log) — everything else is
deterministic.

## Steps

1. **Begin.** `node bin/pulse-core.mjs begin`
   - `skip:true` → a prior tick is still in flight. Stop now. Do **not**
     run `end` — the prior tick will.
   - `isFirstRun:true` → run `node bin/pulse-core.mjs bootstrap` before
     step 2 (seeds the inbox from the vault on a cold start).

2. **Drain + parse.** `node bin/pulse-core.mjs drain` returns a JSON
   array of `{cell, content, path}` — only entries that need parsing
   (unchanged re-pushes are auto-skipped). If it's `[]`, skip to step 3.

   For each entry, read `content` — a cell's HEARTBEAT.md prose — and
   turn it into a cron schedule, an array of `{cron, message}`:
   - `cron` is a 5-field crontab (`min hour dom mon dow`), local time.
   - `message` is the terse, second-person wake instruction sent to the
     cell — e.g. *"good morning — summarize today's calendar"*, not
     *"the user wants you to…"*.
   - Skip lines that are documentation, not schedule. Schedule prose has
     a time in it ("8am", "every weekday", "nightly", "every 15 min").
     A cell with no times has declared "no schedule" — save `[]` for it.

   Save each: pipe `{"cell":"<cell>","items":[…],"sourcePath":"<path>"}`
   to `node bin/pulse-core.mjs save-schedule`.

3. **Fire.** `node bin/pulse-core.mjs fire` — deterministic, no thinking.
   Cron-evaluates every cached schedule and wakes any cell that's due.

4. **Daily log.** `node bin/pulse-core.mjs daily-log-check`.
   - `needed:false` → skip.
   - `needed:true` → the result carries `today` and a `fires` array of
     the last 24h. Write a short paragraph (3–5 sentences) summarizing
     those fires — group by cell, note any failures, keep it factual.
     Then pipe `{"date":"<today>","body":"<paragraph>"}` to
     `node bin/pulse-core.mjs write-log`.

5. **Digest.** `node bin/pulse-core.mjs render` — refreshes the
   heartbeats digest.

6. **End.** `node bin/pulse-core.mjs end` — clears the sentinel, stamps
   the tick.

Stop after `end` returns. Don't summarize, don't echo the schedule.
