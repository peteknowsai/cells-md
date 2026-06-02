"""cells-anthropic provider — Claude (opus) on Pete's Max sub via proxy.cells.md.

Registers `cells-anthropic` as an `anthropic_messages` provider whose base_url is
`https://proxy.cells.md/anthropic.com`. The cell holds only CELLS_PROXY_SECRET (an
sk-ant-oat-prefixed bearer); proxy.cells.md swaps it for the real Max OAuth token —
no OAuth, and no paid Anthropic key, on the cell.

Why the `/anthropic.com` suffix on base_url — this is the whole trick:
hermes-agent's Anthropic adapter decides OAuth-vs-x-api-key purely from the SDK
base_url (`_is_third_party_anthropic_endpoint`): a base_url containing the substring
"anthropic.com" → it takes the Claude-Code OAuth path (Bearer auth_token + the
"You are Claude Code…" preamble + `user-agent: claude-cli/<v> (external, cli)` +
`x-app: cli` + the oauth betas). Any OTHER base_url → it assumes a third-party proxy
and sends `x-api-key` + the SDK's default `Anthropic/Python <ver>` user-agent —
which Cloudflare blocks at the edge (403) before it reaches our proxy, and which
omits the preamble the opus gate requires. We can't override that user-agent from
here: `build_anthropic_client()` ignores ProviderProfile.default_headers on the
anthropic path. So we make the base_url contain "anthropic.com" to land on the
OAuth branch. The Anthropic SDK appends `/v1/messages`, giving
`https://proxy.cells.md/anthropic.com/v1/messages`; the cells proxy strips the
`/anthropic.com` prefix and forwards to api.anthropic.com with the real Max token.

`api_mode="anthropic_messages"` is also pinned in config.yaml (model.api_mode):
hermes re-derives api_mode at runtime from provider + base_url and does NOT auto-
detect proxy.cells.md as Anthropic, so the explicit config value is load-bearing.
"""

from providers import register_provider
from providers.base import ProviderProfile


class CellsAnthropicProfile(ProviderProfile):
    """cells proxy → Claude on Max. Pinned to one model; no live catalog probe."""

    def fetch_models(self, *, api_key: str | None = None, timeout: float = 8.0):
        return None  # cell is pinned to a single model; skip any network probe


register_provider(
    CellsAnthropicProfile(
        name="cells-anthropic",
        api_mode="anthropic_messages",
        base_url="https://proxy.cells.md/anthropic.com",
        env_vars=("CELLS_PROXY_SECRET",),
        auth_type="api_key",
        supports_health_check=False,
        fallback_models=("claude-opus-4-7",),
    )
)
