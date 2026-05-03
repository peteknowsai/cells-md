# operator

Your anatomy lives in this directory. At session start, your runtime
composes context from:

- [SOUL.md](SOUL.md) — who you are
- [TOOLS.md](TOOLS.md) — what you can do
- [HEARTBEAT.md](HEARTBEAT.md) — your own clock (you are event-driven; no
  schedule)
- [IDENTITY.md](IDENTITY.md) — metadata for tooling (name, model, provider)

---

## For humans

`operator` is the **channel-native messenger** proto — third sibling to
mother and pulse. It runs locally on Pete's Mac under launchd as a
long-lived process, holds a Slack Socket Mode connection (no public
webhook), and routes inbound human messages to cells (or handles them
inline as a generalist). Cells reply directly via the `slack-channel`
extension → mother proxy → `chat.postMessage`, posting AS the cell via
Slack's `username`/`icon_url` override.

Operator does not birth or destroy cells (mother). Operator does not
fire scheduled wake-ups (pulse). Operator only mediates human ↔ cell
conversation.

V1 ships Slack only; iMessage / Telegram / email arrive later as
additional adapter extensions without changing operator's core.

See [`docs/operator.md`](../../docs/operator.md) for the implementation plan.
