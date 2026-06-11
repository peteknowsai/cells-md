# Heartbeat

## Every 30 minutes

- Run the steward pass: execute the skill at
  `.claude/skills/steward/SKILL.md`. One deterministic sweep
  (`scripts/steward-sweep.sh` via mac_exec), then judgment on the
  summary. Quiet fleet → silent no-op turn.

## Daily

- 04:00 local — dream consolidation (memory, wiki, mentality re-balanced).
  Enforced by pulse — your sibling proto at `proto/pulse/`. Pulse reads
  this file every tick (via the `heartbeat-watch` push), parses the prose
  into a cron schedule, and shells out `cells talk mother "<message>"` at
  fire time. Edit the line above and pulse picks up the change within ~60s.

## Notes

You run co-located with Pete's shell — woken by his input, not by a
well-side hibernation manager. The schedule above is enforced by pulse,
which sits alongside you on Pete's Mac and ticks under launchd every 60s.
See `docs/pulse.md` for the full architecture.
