# Pi internals — what we know

Living notes from spelunking the pi binary while building the mother's proxy.

## Where pi lives

- Binary: `~/.bun/bin/pi` → symlink into `@mariozechner/pi-coding-agent/dist/cli.js`
- Core agent: `@mariozechner/pi-agent-core` (under `~/.bun/install/global/node_modules`)
- LLM client: `@mariozechner/pi-ai` (vendored under pi-agent-core)
- Models registry: `pi-ai/dist/models.generated.js`
- Anthropic provider: `pi-ai/dist/providers/anthropic.js`

## Anthropic auth dispatch (read the source 2026-04-30)

`createClient(model, apiKey, …)` in `providers/anthropic.js`:

1. If `model.provider === "github-copilot"` → Bearer auth.
2. Else if `apiKey.includes("sk-ant-oat")` → **OAuth path**: Bearer auth,
   plus `anthropic-beta: claude-code-20250219, oauth-2025-04-20`,
   `user-agent: claude-cli/<version>`, `x-app: cli`.
3. Else → **API key path**: `x-api-key` header.

The substring match on `sk-ant-oat` is the only thing distinguishing the
two paths. Anything containing that string gets OAuth treatment.

## Base URL

Set per-model in `models.generated.js`. There is no `ANTHROPIC_BASE_URL`
support — the SDK respects it but pi-ai does its own client construction
with `baseURL: model.baseUrl`. To redirect, you sed-patch the registry.

## Env reading

`pi-ai/dist/env-api-keys.js` has a fallback for a Bun bug: if `process.env`
is empty (compiled-binary sandbox case), it reads `/proc/self/environ`.
Cached after first read. Implication: env changes after pi starts are
invisible. Restart pi to apply.

## Tools / parallelism

Pi's tool dispatcher runs **independent tool calls in a single tool block
concurrently**. This is the parallelism primitive. `talk_to_self` (a
self-tools extension) forks a fresh pi instance and returns its reply;
firing N talk_to_self calls in one block = N parallel subagents. No
tmux/bash needed.

## Identity headers

Pi sends `x-app: cli` and `user-agent: claude-cli/<ver>` on the OAuth path.
The proxy passes these straight through.
