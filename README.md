# cells

A fleet of AI agents, each in its own little Linux machine.

You hand it a problem. It builds the team — a Chief of Staff with cells under it, each owning a piece of the work, all running on your Mac.

---

## Status — alpha

This is being built in the open. **You cannot run it on a fresh machine yet.**

A working install needs:
- a host substrate (`wells`) that owns the Linux VMs — a separate component
- a proxy bridge (`cells-proxy`) that routes a cell's LLM calls through your own Claude Max / ChatGPT Plus subscriptions instead of API billing
- two consumer subscriptions in good standing (Anthropic + OpenAI)

Cells is the layer above all of that — the CLI, the birth ritual, the agent-to-agent channel, the per-cell Cloudflare worker. The substrate itself isn't self-serve yet. If you want to follow along, the design docs in `docs/proposals/` are the best entry point.

## What it is

- A cell is a little Linux machine on your Mac with one agent inside it.
- Cells talk to each other — `cells talk` for ask-and-answer, `cells verify` for cross-checked decisions.
- Cells get a public web presence at `<name>.cells.md`, served via a per-cell Cloudflare Durable Object — they stay reachable when the laptop sleeps.
- Birth happens via "mother," a special cell that runs a deterministic birthing ritual. Hand it a JSON blob, get back a working cell.
- Three harnesses today: **pi** (full agent stack), **claude-code** (Anthropic's CLI), **codex** (OpenAI's CLI). All three speak the same channels primitive.

For the long form, see [`docs/proposals/what-is-cells.html`](docs/proposals/what-is-cells.html).

## Layout

```
cli/              Mac-side CLI (cells, dashboard, host-bridge, proxy, worker/)
dna/              The DNA every cell inherits — base/, specials/ (mother, pulse), skills
docs/             Design docs and proposals — HTML-primary
scripts/          Birth, acceptance, harden, eval scripts
colonies/         Multi-cell recipes (e.g. jurypool)
```

## Built with

- [Bun](https://bun.sh) — runtime
- [Cloudflare Workers + Durable Objects](https://workers.cloudflare.com) — per-cell network presence
- [pi](https://pi.ai) (the CLI) and [claude-code](https://claude.com/claude-code) — agent harnesses

## License

MIT. See [LICENSE](LICENSE).
