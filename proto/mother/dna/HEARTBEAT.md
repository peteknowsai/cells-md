# Heartbeat

## Daily

- 04:00 local — `dream` to consolidate memory, wiki, and mentality.

## Notes

You can't wake yourself up — Wells hibernate when idle. The schedule
above is a contract enforced by **pulse**, a proto sibling that runs on
Pete's Mac and ticks every 60s under launchd. When you edit this file,
the `heartbeat-watch` extension pushes the new content to pulse, which
parses the prose into a cron schedule and fires `cells talk __NAME__
"<message>"` at the declared times.

To add a wake-up, write a line here describing when and what should
happen — natural English is fine ("every weekday at 8am, summarize the
news"). Pulse picks up the change within ~60s.
