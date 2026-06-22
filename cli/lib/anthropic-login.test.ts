import { describe, it, expect } from "bun:test";
import {
  ANTHROPIC_CLIENT_ID,
  AUTHORIZE_URL,
  REDIRECT_URI,
  SCOPES,
  pkceChallengeFromVerifier,
  generatePkce,
  buildAuthorizeUrl,
  tokenExchangeBody,
  parseTokenResponse,
  parseAuthInput,
  mergeAnthropicAuth,
} from "./anthropic-login";

describe("pkce", () => {
  it("matches the RFC 7636 S256 test vector", () => {
    // From RFC 7636 Appendix B.
    expect(pkceChallengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates a verifier whose challenge is the base64url sha256 of it", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).toBe(pkceChallengeFromVerifier(verifier));
    expect(challenge).not.toMatch(/[+/=]/); // base64url, not base64
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries the client, redirect, scopes, S256 challenge, and state", () => {
    const url = new URL(buildAuthorizeUrl("CHAL", "STATE"));
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(ANTHROPIC_CLIENT_ID);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(p.get("scope")).toBe(SCOPES);
    expect(p.get("code_challenge")).toBe("CHAL");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("STATE");
  });
});

describe("tokenExchangeBody", () => {
  it("is an authorization_code grant with the verifier", () => {
    const b = tokenExchangeBody("CODE", "STATE", "VERIFIER", REDIRECT_URI);
    expect(b).toEqual({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      code: "CODE",
      state: "STATE",
      redirect_uri: REDIRECT_URI,
      code_verifier: "VERIFIER",
    });
  });
});

describe("parseTokenResponse", () => {
  it("maps tokens and applies the 5-minute skew to expires", () => {
    const now = 1_000_000_000_000;
    const creds = parseTokenResponse(
      JSON.stringify({ access_token: "sk-ant-oat01-x", refresh_token: "sk-ant-ort01-y", expires_in: 36000 }),
      now,
    );
    expect(creds.type).toBe("oauth");
    expect(creds.access).toBe("sk-ant-oat01-x");
    expect(creds.refresh).toBe("sk-ant-ort01-y");
    expect(creds.expires).toBe(now + 36000 * 1000 - 5 * 60 * 1000);
  });

  it("throws when the response is missing tokens", () => {
    expect(() => parseTokenResponse(JSON.stringify({ error: "bad" }), 0)).toThrow();
  });
});

describe("parseAuthInput", () => {
  it("extracts code+state from a full redirect URL", () => {
    expect(parseAuthInput("http://localhost:53692/callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
  });
  it("splits a code#state pair", () => {
    expect(parseAuthInput("abc#xyz")).toEqual({ code: "abc", state: "xyz" });
  });
  it("parses a bare query string", () => {
    expect(parseAuthInput("code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
  });
  it("treats a bare token as the code", () => {
    expect(parseAuthInput("just-a-code")).toEqual({ code: "just-a-code" });
  });
  it("returns empty on blank input", () => {
    expect(parseAuthInput("   ")).toEqual({});
  });
});

describe("mergeAnthropicAuth", () => {
  const creds = { type: "oauth" as const, access: "a", refresh: "r", expires: 123 };

  it("sets the anthropic block while preserving other providers", () => {
    const merged = mergeAnthropicAuth({ "openai-codex": { type: "oauth", access: "ca" } }, creds);
    expect(merged.anthropic).toEqual(creds);
    expect(merged["openai-codex"]).toEqual({ type: "oauth", access: "ca" });
  });

  it("replaces a stale anthropic block", () => {
    const merged = mergeAnthropicAuth({ anthropic: { type: "oauth", access: "old", refresh: "old", expires: 1 } }, creds);
    expect(merged.anthropic).toEqual(creds);
  });

  it("handles a null/empty existing file", () => {
    expect(mergeAnthropicAuth(null, creds)).toEqual({ anthropic: creds });
  });
});
