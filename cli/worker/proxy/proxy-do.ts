/**
 * TokenStore — singleton Durable Object holding OAuth tokens for the
 * fleet's LLM proxy. Mother (the Mac refresh-agent) PUTs fresh access
 * tokens here every ~15 min via the Worker's PUT /tokens route. The
 * Worker's request handlers read from this DO on every cell request.
 *
 * Single instance; address it via env.TOKENS.idFromName("tokens").
 */

type AnthropicState = {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
};

type CodexState = {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  accountId: string;
};

export class TokenStore {
  private state: DurableObjectState;
  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const op = url.pathname;

    if (op === "/get-anthropic") {
      return Response.json(await this.getAnthropic());
    }
    if (op === "/get-codex") {
      return Response.json(await this.getCodex());
    }
    if (op === "/set-anthropic") {
      const body = (await req.json()) as AnthropicState;
      await this.setAnthropic(body);
      return Response.json({ ok: true });
    }
    if (op === "/set-codex") {
      const body = (await req.json()) as CodexState;
      await this.setCodex(body);
      return Response.json({ ok: true });
    }
    if (op === "/state") {
      return Response.json(await this.metaState());
    }
    return new Response("not found", { status: 404 });
  }

  private async getAnthropic(): Promise<AnthropicState | null> {
    const access = await this.state.storage.get<string>("anthropicAccessToken");
    const expires = await this.state.storage.get<number>("anthropicAccessTokenExpiresAt");
    if (!access || !expires) return null;
    const refresh = await this.state.storage.get<string>("anthropicRefreshToken");
    return { accessToken: access, expiresAt: expires, refreshToken: refresh };
  }

  private async getCodex(): Promise<CodexState | null> {
    const access = await this.state.storage.get<string>("codexAccessToken");
    const expires = await this.state.storage.get<number>("codexAccessTokenExpiresAt");
    const accountId = await this.state.storage.get<string>("codexAccountId");
    if (!access || !expires || !accountId) return null;
    const refresh = await this.state.storage.get<string>("codexRefreshToken");
    return { accessToken: access, expiresAt: expires, refreshToken: refresh, accountId };
  }

  private async setAnthropic(s: AnthropicState): Promise<void> {
    await this.state.storage.put({
      anthropicAccessToken: s.accessToken,
      anthropicAccessTokenExpiresAt: s.expiresAt,
      ...(s.refreshToken ? { anthropicRefreshToken: s.refreshToken } : {}),
    });
  }

  private async setCodex(s: CodexState): Promise<void> {
    await this.state.storage.put({
      codexAccessToken: s.accessToken,
      codexAccessTokenExpiresAt: s.expiresAt,
      codexAccountId: s.accountId,
      ...(s.refreshToken ? { codexRefreshToken: s.refreshToken } : {}),
    });
  }

  private async metaState(): Promise<{
    anthropic: { expiresAt: number | null; hasRefreshToken: boolean };
    codex: { expiresAt: number | null; hasRefreshToken: boolean; hasAccountId: boolean };
  }> {
    const aExp = (await this.state.storage.get<number>("anthropicAccessTokenExpiresAt")) ?? null;
    const aRef = !!(await this.state.storage.get<string>("anthropicRefreshToken"));
    const cExp = (await this.state.storage.get<number>("codexAccessTokenExpiresAt")) ?? null;
    const cRef = !!(await this.state.storage.get<string>("codexRefreshToken"));
    const cAcct = !!(await this.state.storage.get<string>("codexAccountId"));
    return {
      anthropic: { expiresAt: aExp, hasRefreshToken: aRef },
      codex: { expiresAt: cExp, hasRefreshToken: cRef, hasAccountId: cAcct },
    };
  }
}

export type { AnthropicState, CodexState };
