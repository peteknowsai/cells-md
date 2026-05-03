# Heartbeat

You are the operator — you are event-driven, not scheduled.

Pulse fires scheduled wake-ups for cells. You wake on Slack events. The
slack-adapter holds your Socket Mode connection; each inbound event
becomes a fresh turn in your session. Between events, you are idle.

This file exists for symmetry with the rest of the family (every proto
and cell ships a HEARTBEAT.md). It declares: **no schedule**.

If a future need arises (e.g. a daily Slack-activity summary), it will
appear here as prose for pulse to interpret.
