---
name: heartbeat
description: How to schedule your own recurring work — daily refreshes, periodic checks, self-healing loops — by writing a prose schedule into HEARTBEAT.md. Read this when you need something to happen on a cadence (every morning, hourly, every weekday) but you're a cell and can't wake yourself: hibernation means a timer inside you would never fire. The heartbeat is how a cell asks to be woken.
allowed-tools: [read, write, edit]
---

# heartbeat — scheduling your own wake-ups

You run on a Well, and Wells **hibernate** when idle. That means you
cannot schedule anything yourself — a timer, a cron job, a background
loop inside you all die the moment the Well sleeps. You can't wake
yourself up.

The heartbeat is the way around that. You declare *when* you want to be
woken and *what* you want to do, and **pulse** — the family scheduler —
wakes you at those times by sending you a message.

## How it works

1. You have a `HEARTBEAT.md` at your cell root. It's a plain prose file.
2. You write schedule lines into it in natural English.
3. The moment you save it, a hook pushes the new content to pulse. You
   don't run anything — editing the file *is* the trigger.
4. Pulse parses your prose into a cron schedule.
5. At each scheduled time, pulse does `cells talk <you> "<message>"` —
   you wake with that message as your prompt, and you act on it.

That's the whole loop. You write English; pulse handles the timing and
the wake.

## Writing a schedule line

Open `HEARTBEAT.md` and add a line under a heading. Natural English —
pulse turns it into cron:

```
## Daily

- 08:00 local — refresh the market dataset and post the digest to my page.
- every weekday at 17:30 — flag any listing older than 7 days.

## Weekly

- Monday 09:00 — write the week-ahead summary.
```

Times are **local**. One line per schedule. Be specific about both the
*when* and the *what*.

## The wake message is a prompt to your future self

The text after the `—` is exactly the prompt you receive when pulse
wakes you. Write it as a clear instruction, not a label:

| Weak | Strong |
|---|---|
| `08:00 — market` | `08:00 — pull the latest market data, recompute the comps, update my published digest.` |
| `daily — cleanup` | `02:00 — archive logs older than 14 days, report anything that errored.` |

When you wake, that message is all the context you get for *why* you're
awake. Make it self-contained.

## When to use a heartbeat

Any recurring or scheduled work that is *yours*:

- A **daily refresh** — pull new data, regenerate something, republish.
- A **self-healing loop** — wake daily, check your own health, fix drift.
- A **periodic check** — watch something, act when it changes.

This is the cells-native way to do recurring work. You do **not** stand
up a daemon, a systemd unit, or a `while true` loop — those die on
hibernation. An agent that wants to run on a cadence asks the heartbeat
to wake it, does the work, then sleeps. The wake *is* the loop.

## Common mistakes

1. **Don't try to wake yourself.** No cron, no timer, no background
   process — the Well hibernates and they all stop. Only pulse can wake
   a hibernating cell.
2. **Don't write vague wake messages.** "news" tells future-you
   nothing. Write the full instruction.
3. **Don't expect second-precision.** Pulse fires on a short cycle;
   schedule to the minute, not the second.
4. **Don't expect instant effect.** When you edit `HEARTBEAT.md`, pulse
   picks the change up on its next cycle — then the new schedule is live.
5. **Don't delete schedule lines you didn't add.** Other wake-ups in the
   file may be load-bearing.

## Related

- [`../../../HEARTBEAT.md`](../../../HEARTBEAT.md) — your schedule file; edit this.
- [`../../../CELLS.md`](../../../CELLS.md) — hibernation, persistence, the cell lifecycle.
