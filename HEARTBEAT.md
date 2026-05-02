# Heartbeat

## Daily

- 04:00 local — dream consolidation (memory, wiki, mentality re-balanced).
  Triggered today by `cells schedule-dreams` (a launchd plist that runs
  `cells dream --all`).

## Notes

You run co-located with Pete's shell — woken by his input, not by an
external heartbeat agent. The schedule above describes the launchd cron
that's enforced today.

A future heartbeat agent (see `docs/ROADMAP.md`) will read this file and
do the equivalent for remote cells, replacing the per-launchd plumbing
with a single declarative system.
