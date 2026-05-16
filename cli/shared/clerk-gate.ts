/**
 * Clerk gating — shared between the per-cell Cloudflare Worker
 * (cli/worker/cell/) and the Mac-side proxy (cli/proxy.ts).
 *
 * Both surfaces serve HTML on `*.cells.md` and must apply the same
 * rules: verify the `__session` cookie networklessly, strip
 * `[data-private]` elements for anon visitors, and inject the Clerk
 * widget snippet so the sign-in pill / user button shows on every
 * served page.
 *
 * Bun (the proxy's runtime) exposes the same HTMLRewriter API as the
 * Workers runtime, so the gating function is identical in both
 * contexts — no separate regex stripper, no DOM library. Single
 * source of truth.
 */

import { jwtVerify, importSPKI } from "jose";

// Per-isolate cache of parsed RSA public keys. The PEM string is the
// cache key so a config change (e.g. key rotation) picks up cleanly.
const keyCache = new Map<string, Promise<CryptoKey>>();
function getClerkKey(pem: string): Promise<CryptoKey> {
  let p = keyCache.get(pem);
  if (!p) {
    p = importSPKI(pem, "RS256") as Promise<CryptoKey>;
    keyCache.set(pem, p);
  }
  return p;
}

// Read the `__session` cookie out of a Cookie header. Clerk sets it on
// the apex (`.cells.md`) so it lives on every subdomain.
export function getSessionCookie(cookie: string | null): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === "__session") return part.slice(eq + 1).trim();
  }
  return null;
}

// Returns true iff the request carries a valid `__session` JWT signed
// by `jwtKey`. Any failure (no key, no cookie, bad sig, expired) falls
// back to anonymous — the site keeps serving, just with private
// content stripped.
export async function verifyClerkSession(
  req: Request,
  jwtKey: string | undefined,
): Promise<boolean> {
  if (!jwtKey) return false;
  const token = getSessionCookie(req.headers.get("cookie"));
  if (!token) return false;
  try {
    const key = await getClerkKey(jwtKey);
    await jwtVerify(token, key, { algorithms: ["RS256"] });
    return true;
  } catch {
    return false;
  }
}

// Derive the Clerk frontend API host from a publishable key. The pk
// format is `pk_(test|live)_<base64url-of-frontend-api$>`. Returns an
// empty string on any parse error — callers should skip widget
// injection in that case.
export function frontendApiFromPk(pk: string): string {
  const i = pk.lastIndexOf("_");
  if (i < 0) return "";
  const enc = pk.slice(i + 1);
  try {
    const padded = enc + "=".repeat((4 - (enc.length % 4)) % 4);
    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.replace(/\$+$/, "");
  } catch {
    return "";
  }
}

// HTML snippet injected before `</body>` on every served HTML page.
// Loads @clerk/ui@1 first (registers window.__internal_ClerkUICtor),
// then clerk-js, then Clerk.load({ ui }). Script-tag order matters;
// `defer` preserves it. Renders a fixed top-right pill: UserButton
// when signed in, "Sign in" button (opens an inline overlay) otherwise.
export function clerkWidgetSnippet(pk: string, frontendApi: string): string {
  const escPk = pk.replace(/"/g, "&quot;");
  const escApi = frontendApi.replace(/"/g, "&quot;");
  return `
<script defer crossorigin="anonymous" src="https://${escApi}/npm/@clerk/ui@1/dist/ui.browser.js" type="text/javascript"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${escPk}" src="https://${escApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js" type="text/javascript"></script>
<div id="cells-clerk-mount" style="position:fixed;top:12px;right:12px;z-index:9999;font:14px system-ui"></div>
<script>
(function(){
  function openSignInOverlay(){
    if (document.getElementById("cells-clerk-overlay")) return;
    var overlay = document.createElement("div");
    overlay.id = "cells-clerk-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:99999;padding:1em";
    var formHost = document.createElement("div");
    formHost.id = "cells-clerk-form";
    overlay.appendChild(formHost);
    overlay.addEventListener("click", function(e){ if (e.target === overlay) close(); });
    function close(){ try { Clerk.unmountSignIn(formHost); } catch(_){}; overlay.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    try { Clerk.mountSignIn(formHost); } catch (e) { console.error("mountSignIn:", e); }
  }
  window.addEventListener("load", async function(){
    try {
      if (typeof Clerk === "undefined") { console.error("clerk widget: Clerk global missing"); return; }
      await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
      var mount = document.getElementById("cells-clerk-mount");
      if (!mount) return;
      if (Clerk.user) {
        Clerk.mountUserButton(mount);
      } else {
        var btn = document.createElement("button");
        btn.textContent = "Sign in";
        btn.style.cssText = "padding:6px 14px;border-radius:999px;background:#111;color:#fff;border:none;cursor:pointer;font:14px system-ui;box-shadow:0 1px 3px rgba(0,0,0,.2)";
        btn.onclick = openSignInOverlay;
        mount.appendChild(btn);
      }
    } catch (e) { console.error("clerk widget:", e); }
  });
})();
</script>`;
}

// Apply the Clerk-aware HTML transforms to a Response: strip
// `[data-private]` elements for anon visitors, inject the widget
// snippet before `</body>`. Non-HTML responses pass through.
//
// Works in both Cloudflare Workers and Bun (proxy) — both runtimes
// expose the same HTMLRewriter global, so this single function covers
// both surfaces.
export function gateHtml(
  response: Response,
  opts: { signedIn: boolean; publishableKey?: string },
): Response {
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("text/html")) return response;

  const pk = opts.publishableKey ?? "";
  const api = pk ? frontendApiFromPk(pk) : "";
  const widget = (pk && api) ? clerkWidgetSnippet(pk, api) : "";

  let rewriter = new HTMLRewriter();
  if (!opts.signedIn) {
    rewriter = rewriter.on("[data-private]", {
      element(el: { remove(): void }) { el.remove(); },
    });
  }
  if (widget) {
    rewriter = rewriter.on("body", {
      element(el: { append(c: string, opts?: { html?: boolean }): void }) {
        el.append(widget, { html: true });
      },
    });
  }
  return rewriter.transform(response);
}
