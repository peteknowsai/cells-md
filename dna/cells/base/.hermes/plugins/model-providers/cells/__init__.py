"""cells proxy provider — gpt-5.5 on the ChatGPT subscription via proxy.cells.md.

Registers `cells` as a codex_responses (OpenAI Responses API) provider
pointed at the cells subscriptions proxy. The cell holds only
CELLS_PROXY_SECRET (exported as OPENAI_CODEX_API_KEY); proxy.cells.md/codex
swaps it for the real ChatGPT-subscription token — no OAuth on the cell.

Why a plugin and not a config.yaml `providers:` entry: a config-defined
provider resolves to hermes's Ollama-flavoured `custom` profile, which
pre-flight-probes Ollama endpoints (/api/show, /v1/models) that the codex
backend 403s — killing the turn before it starts. A registered
ProviderProfile is a first-class provider with its own api_mode and none of
the Ollama behaviour.

Why `default_headers` pins the User-Agent: the Cloudflare edge in front of
proxy.cells.md flags the OpenAI Python SDK's default UA (`OpenAI/Python
<ver>`) as a known bot and serves a 403 "Your request was blocked" — the
request never reaches our proxy. Any non-SDK UA passes. We mimic the codex
CLI's UA so the wire shape matches what the codex backend expects anyway.
(The proxy already injects `originator: codex_cli` upstream.)
"""

from providers import register_provider
from providers.base import ProviderProfile

register_provider(
    ProviderProfile(
        name="cells",
        api_mode="codex_responses",
        base_url="https://proxy.cells.md/codex",
        env_vars=("OPENAI_CODEX_API_KEY",),
        supports_health_check=False,
        default_headers={"User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)"},
    )
)
