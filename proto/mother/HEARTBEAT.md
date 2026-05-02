# Heartbeat

## Daily

- 04:00 local — dream consolidation (memory, wiki, mentality re-balanced).
  Enforced by pulse — your sibling proto at `proto/pulse/`. Pulse reads
  this file every tick (via the `heartbeat-watch` push), parses the prose
  into a cron schedule, and shells out `cells talk mother "<message>"` at
  fire time. Edit the line above and pulse picks up the change within ~60s.

## Notes

You run co-located with Pete's shell — woken by his input, not by a
sprite-side hibernation manager. The schedule above is enforced by pulse,
which sits alongside you on Pete's Mac and ticks under launchd every 60s.
See `docs/pulse.md` for the full architecture.
