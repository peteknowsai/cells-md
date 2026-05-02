---
name: pulse
description: One pulse tick. Drain inbox, fire due wakes, maybe write daily log, render digest.
---

This is one pulse tick. Be terse. No prose, no narration — just tool calls and one-line summaries.

## Steps

1. **Begin.** Call `tick_begin`.
   - If `skip=true`, log one line ("skip — prior tick in flight") and STOP. Do not call `tick_end`; the prior tick will.
   - If `isFirstRun=true`, call `bootstrap_inbox` before step 2.

2. **Drain inbox.** Call `drain_inbox`.
   - For each entry returned, parse `content` (a HEARTBEAT.md prose schedule) into a JSON array
     `[{id, cron, message}]`. Rules:
     - `cron` must be a valid 5-field crontab (`min hour dom mon dow`), local time on this Mac.
     - `id` is a stable slug from the human intent — e.g. `"weekday-news"`, `"midnight-checkpoint"`.
       Same prose → same id, so re-parses don't churn `lastFire`.
     - `message` is what to send via `cells talk` — terse, second-person, imperative. Example:
       *"good morning, summarize today's calendar"* not *"the user wants you to..."*.
     - Skip lines that are documentation, not schedule. Schedule prose typically contains a time
       ("8am", "every weekday", "nightly", "every 15 min"). If no times appear, the cell has
       declared "no schedule" — call `save_schedule(cell, [], sourcePath)` with an empty array.
   - For each parsed entry, call `save_schedule(cell, items, sourcePath)`.

3. **Fire due wakes.** Call `fire_due`. Pure compute — no LLM work.

4. **Daily log.** Call `daily_log_due`.
   - If `needed=false`, skip.
   - If `needed=true`: write a short paragraph (3-5 sentences) summarizing the `fires` array.
     Group by cell, mention any failures, keep it factual and terse. Then call
     `write_log_entry(today, body)`.
   - If `fires` is empty for the day, write something like *"Quiet day — no scheduled wakes
     fired."* and log it anyway, so log.md has a continuous record.

5. **Digest.** Call `render_digest` to refresh `state/heartbeats.md`.

6. **End.** Call `tick_end`.

End the response after `tick_end` returns. Don't summarize. Don't echo the schedule. The vault
files (`heartbeats.md`, `log.md`) are the surface; the JSON state is the truth.
