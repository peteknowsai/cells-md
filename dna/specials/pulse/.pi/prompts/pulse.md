---
name: pulse
description: One pulse. Drain inbox, fire due wakes, maybe write daily log, render digest.
---

This is one pulse. Be terse. No prose, no narration — just tool calls and one-line summaries.

## Steps

1. **Begin.** Call `pulse_begin`.
   - If `skip=true`, log one line ("skip — prior pulse in flight") and STOP. Do not call `pulse_end`; the prior pulse will.
   - If `isFirstRun=true`, call `bootstrap_inbox` before step 2.

2. **Drain inbox.** Call `drain_inbox`. Returns only entries that need re-parsing
   (no-op edits — content unchanged from cache — are auto-moved to processed/ already).
   - For each entry returned, parse `content` (a HEARTBEAT.md prose schedule) into a JSON array
     `[{id, cron, message}]`. Rules:
     - `cron` must be a valid 5-field crontab (`min hour dom mon dow`), local time on this Mac.
     - `id` is just a hint — `save_schedule` overrides it with a deterministic slug+hash of
       (cron, normalized message). You don't need to make it unique or stable.
     - `message` is what to send via `cells talk` — terse, second-person, imperative. Example:
       *"good morning, summarize today's calendar"* not *"the user wants you to..."*.
     - Skip lines that are documentation, not schedule. Schedule prose typically contains a time
       ("8am", "every weekday", "nightly", "every 15 min"). If no times appear, the cell has
       declared "no schedule" — call `save_schedule(cell, [], sourcePath)` with an empty array.
   - For each parsed entry, call `save_schedule(cell, items, sourcePath)`.

3. **Fire due wakes.** Call `fire_due`. Pure compute — no LLM work.

4. **Daily log.** Call `daily_log_due`.
   - If `needed=false`, skip.
   - If `needed=true`: the response gives you `today` (local-TZ date — rolls over at midnight
     Pacific) and `fires` (last 24h of fires). Write a short paragraph (3-5 sentences)
     summarizing the `fires` array — group by cell, mention any failures, keep it factual and
     terse. Then call `write_log_entry(today, body)` passing the date you got back verbatim.
   - If `fires` is empty for the day, write something like *"Quiet day — no scheduled wakes
     fired."* and log it anyway, so log.md has a continuous record.

5. **Digest.** Call `render_digest` to refresh `state/heartbeats.md`.

6. **End.** Call `pulse_end`.

End the response after `pulse_end` returns. Don't summarize. Don't echo the schedule. The vault
files (`heartbeats.md`, `log.md`) are the surface; the JSON state is the truth.
