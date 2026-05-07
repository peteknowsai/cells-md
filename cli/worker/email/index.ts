/**
 * cells-front-email — the Email twin.
 *
 * Two entry points:
 *   email(message)      — Cloudflare Email Routing invokes this for every
 *                         message delivered to the cells.md catch-all.
 *                         Resolves <local-part>@cells.md → cell via the
 *                         CHANNELS KV (key shape "email:<local-part>"),
 *                         parses MIME via PostalMime, enriches attachments
 *                         (image/PDF/text) and POSTs to the cell at
 *                         https://<cell>.cells.md/inbox/append.
 *
 *   POST /send (fetch)  — outbound endpoint cell agents call to send
 *                         email replies. Mirrors slack.cells.md/send:
 *                         body { cell, text, to, inReplyTo?, subject? }.
 *                         Auth via CELLS_PROXY_SECRET. Sends via the
 *                         SEND_EMAIL binding from <cell>@cells.md.
 *
 * Design notes:
 *  - No KV-lookup-then-bounce dance: if the local-part is unbound we
 *    `message.setReject("No such cell")` so Cloudflare returns SMTP 550.
 *  - Subaddressing (bob+anything@cells.md) is stripped before lookup;
 *    the suffix is not exposed to the agent.
 *  - Attachment enrichment mirrors slack/index.ts (image base64, PDF
 *    via Gemini 2.5 Flash, text/code inlined as fenced blocks). Audio
 *    transcription path is intentionally skipped — voice notes aren't a
 *    typical email pattern; revisit if real users send .mp3 attachments.
 */

import PostalMime from "postal-mime";

export interface Env {
  CHANNELS: KVNamespace;
  CELLS_PROXY_SECRET: string;
  // OpenAI key — currently unused on the email path; kept in the Env
  // shape so the same enrichment helpers can lift over from the slack
  // worker without churn if voice attachments become a thing.
  OPENAI_API_KEY: string;
  // Gemini for PDF text/OCR extraction. Same key the slack worker uses.
  GEMINI_API_KEY: string;
  // Cloudflare Email Sending binding. The .send() takes an EmailMessage
  // built from "cloudflare:email"; types aren't in @cloudflare/workers-types
  // yet (public beta as of 2026-04), so we declare the surface narrowly.
  SEND_EMAIL: { send(message: any): Promise<void> };
}

// Inbound EmailMessage from Email Routing. Re-stated narrowly so this
// file documents what it actually uses.
interface InboundEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

type ImageContent = { type: "image"; data: string; mimeType: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 100 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-toml",
  "application/toml",
]);

const MIME_TO_LANG: Record<string, string> = {
  "application/json": "json",
  "application/xml": "xml",
  "application/javascript": "js",
  "application/typescript": "ts",
  "application/x-yaml": "yaml",
  "application/yaml": "yaml",
  "application/x-sh": "sh",
  "application/x-shellscript": "sh",
  "application/x-toml": "toml",
  "application/toml": "toml",
  "text/markdown": "md",
  "text/x-python": "py",
  "text/x-go": "go",
  "text/x-rust": "rs",
  "text/x-java": "java",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
};

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/send") return handleSend(req, env);
    return new Response("not found", { status: 404 });
  },

  async email(message: InboundEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const { local, full } = parseRecipient(message.to);
    if (!local) {
      message.setReject("Invalid recipient");
      return;
    }

    // KV key shape: "email:<local-part>". Value is the cell name. Falls
    // back to a bare "<local-part>" lookup so a manually-linked binding
    // (cells channel link bob bob@cells.md) without the prefix still
    // routes — defensive, not load-bearing.
    const cell = (await env.CHANNELS.get(`email:${local}`, { cacheTtl: 60 }))
      ?? (await env.CHANNELS.get(local, { cacheTtl: 60 }));
    if (!cell) {
      console.log(`reject unbound: to=${full} local=${local}`);
      message.setReject(`No such cell: ${local}`);
      return;
    }

    // Read the raw RFC 5322 message into a buffer so PostalMime can
    // parse and we can hand attachment buffers to the enrichment helpers.
    const raw = await streamToBuffer(message.raw, message.rawSize);
    const parsed = await PostalMime.parse(raw);

    const subject = (parsed.subject ?? "").trim();
    const messageId = (parsed.messageId ?? "").trim();
    // Plain text preferred; fall back to a crude HTML strip if the sender
    // only sent text/html (Outlook, some mobile clients).
    const bodyText = (parsed.text ?? "").trim()
      || stripHtml(parsed.html ?? "").trim()
      || "(empty body)";

    console.log(
      `route ${full} -> ${cell} (from=${message.from} subj="${subject.slice(0, 60)}" `
      + `attachments=${parsed.attachments?.length ?? 0} msgid=${messageId})`,
    );

    ctx.waitUntil((async () => {
      const enriched = await enrichWithAttachments(parsed.attachments ?? [], bodyText, env);

      const event = {
        // For the cell-agent these fields are kind-agnostic; the kind
        // discriminator + email-specific fields below let it choose the
        // right outbound path on reply.
        channel: message.from,           // sender's address — used as reply-to
        user: message.from,
        text: enriched.text,
        thread_ts: messageId,            // RFC 822 Message-ID; reused as In-Reply-To
        subject,
        kind: "email" as const,
        recipient: full,                 // who they wrote to (e.g., bob@cells.md)
      };

      const r = await fetch(`https://${cell}.cells.md/inbox/append`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CELLS_PROXY_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event,
          images: enriched.images,
          team_id: "email",
          event_id: messageId,
        }),
      }).catch((e) => { console.error(`fan-out to ${cell} threw: ${String(e).slice(0, 300)}`); return null; });
      if (!r) return;
      console.log(`fan-out -> ${cell}: ${r.status}`);
      if (!r.ok) console.error(`fan-out body: ${(await r.text()).slice(0, 200)}`);
    })());
  },
};

// ───────────────────── recipient parsing ─────────────────────

function parseRecipient(to: string): { local: string; full: string } {
  // message.to may be either a bare address or a Name <addr> form on
  // some routes — the EmailMessage spec says bare, but be defensive.
  const m = to.match(/<([^>]+)>/);
  const addr = (m?.[1] ?? to).trim().toLowerCase();
  const at = addr.indexOf("@");
  if (at < 0) return { local: "", full: addr };
  let local = addr.slice(0, at);
  // Strip RFC 5233 sub-addressing: bob+anything → bob. The suffix is
  // dropped before agent dispatch, mirroring how Gmail treats it.
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  return { local, full: addr };
}

// ───────────────────── attachment enrichment ─────────────────────

async function enrichWithAttachments(
  attachments: any[],
  baseText: string,
  env: Env,
): Promise<{ text: string; images: ImageContent[] }> {
  if (!attachments.length) return { text: baseText, images: [] };

  const images: ImageContent[] = [];
  const additions: string[] = [];

  for (const att of attachments) {
    const mime = String(att.mimeType ?? att.contentType ?? "application/octet-stream").toLowerCase();
    const name = String(att.filename ?? att.name ?? "attachment");
    const buf = attachmentBuffer(att);
    if (!buf) {
      additions.push(`[file: ${name} (${mime}) — could not read content]`);
      continue;
    }
    try {
      if (mime.startsWith("image/")) {
        if (buf.byteLength > MAX_IMAGE_BYTES) {
          additions.push(`[image: ${name} (${mime}, ${kb(buf.byteLength)}) — too large, skipped]`);
          continue;
        }
        images.push({ type: "image", data: bytesToBase64(new Uint8Array(buf)), mimeType: mime });
      } else if (mime === "application/pdf") {
        if (buf.byteLength > MAX_PDF_BYTES) {
          additions.push(`[file: ${name} (pdf, ${kb(buf.byteLength)}) — too large for inline extraction]`);
          continue;
        }
        const text = await extractPdfText(buf, env.GEMINI_API_KEY);
        additions.push(`[file: ${name}]\n${text}`);
      } else if (mime.startsWith("text/") || TEXT_MIMES.has(mime)) {
        if (buf.byteLength > MAX_TEXT_BYTES) {
          additions.push(`[file: ${name} (${mime}, ${kb(buf.byteLength)}) — too large to inline]`);
          continue;
        }
        const lang = MIME_TO_LANG[mime] ?? extOf(name);
        const body = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buf);
        additions.push(`[file: ${name}]\n\`\`\`${lang}\n${body}\n\`\`\``);
      } else {
        additions.push(`[file: ${name} (${mime}, ${kb(buf.byteLength)}) — not yet supported]`);
      }
    } catch (e) {
      console.error(`enrich attachment ${name} (${mime}): ${String(e).slice(0, 200)}`);
      additions.push(`[file: ${name} — failed to process]`);
    }
  }

  const text = [baseText, ...additions].filter(Boolean).join("\n\n");
  return { text, images };
}

// PostalMime returns content as either an ArrayBuffer (binary) or a
// string (when disposition is text). Normalize to ArrayBuffer.
function attachmentBuffer(att: any): ArrayBuffer | null {
  const c = att?.content;
  if (!c) return null;
  if (c instanceof ArrayBuffer) return c;
  if (ArrayBuffer.isView(c)) {
    const view = c as ArrayBufferView;
    const buf = view.buffer as ArrayBuffer;
    return buf.slice(view.byteOffset, view.byteOffset + view.byteLength);
  }
  if (typeof c === "string") {
    return new TextEncoder().encode(c).buffer as ArrayBuffer;
  }
  return null;
}

async function extractPdfText(buf: ArrayBuffer, geminiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: "application/pdf", data: bytesToBase64(new Uint8Array(buf)) } },
        { text: "Extract every text element from this document, preserving structure with headings, lists, and tables where present. Output only the extracted text — no commentary, no preamble." },
      ],
    }],
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
  return String(text).trim() || "(empty extraction)";
}

// ───────────────────── outbound: cell → email ─────────────────────

async function handleSend(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.CELLS_PROXY_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: {
    cell?: string;
    text?: string;
    to?: string;
    inReplyTo?: string;
    subject?: string;
    from?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const cell = (payload.cell ?? "").trim();
  const text = payload.text ?? "";
  const to = (payload.to ?? "").trim();
  if (!cell || !/^[a-z0-9-]+$/.test(cell)) return new Response("missing or bad cell", { status: 400 });
  if (typeof text !== "string" || !text) return new Response("missing text", { status: 400 });
  if (!to || !/.+@.+/.test(to)) return new Response("missing or bad to", { status: 400 });

  const from = (payload.from ?? `${cell}@cells.md`).trim();
  const subject = (payload.subject ?? "(no subject)").trim();
  const inReplyTo = (payload.inReplyTo ?? "").trim();

  const raw = buildRfc822({ from, fromName: cell, to, subject, text, inReplyTo });

  // The Cloudflare SDK's EmailMessage class is a thin wrapper around a
  // raw MIME blob; we build it ourselves to keep deps minimal. Workers
  // resolves "cloudflare:email" at runtime — see the docs example Pete
  // shared.
  const { EmailMessage } = await import("cloudflare:email");
  const msg = new EmailMessage(from, to, raw);

  try {
    await env.SEND_EMAIL.send(msg);
    console.log(`email ${cell} → ${to} ok subj="${subject.slice(0, 60)}" (${text.length}B)`);
    return Response.json({ ok: true });
  } catch (e) {
    const err = String(e).slice(0, 300);
    console.error(`email ${cell} → ${to} FAIL: ${err}`);
    return Response.json({ ok: false, error: err }, { status: 502 });
  }
}

// Build a minimal RFC 5322 message. Plain text only for v1; if you want
// HTML later, add a multipart/alternative wrapper.
function buildRfc822(opts: {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo: string;
}): string {
  const msgId = `<${crypto.randomUUID()}@cells.md>`;
  const date = new Date().toUTCString();
  const headers = [
    `From: ${encodeFromName(opts.fromName)} <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
  ];
  if (opts.inReplyTo) {
    // Wrap the msgid in <> if the sender stored a bare form.
    const ref = opts.inReplyTo.startsWith("<") ? opts.inReplyTo : `<${opts.inReplyTo}>`;
    headers.push(`In-Reply-To: ${ref}`);
    headers.push(`References: ${ref}`);
  }
  return headers.join("\r\n") + "\r\n\r\n" + opts.text;
}

// RFC 2047 encoded-word for non-ASCII in display names / subjects.
// Falls through unencoded for pure-ASCII (the common case).
function encodeHeader(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return `=?utf-8?B?${b64}?=`;
}

function encodeFromName(name: string): string {
  // Quote display names with anything beyond [A-Za-z0-9 -]; keep
  // typical cell names unquoted.
  if (/^[A-Za-z0-9 .-]+$/.test(name)) return name;
  return `"${name.replace(/"/g, '\\"')}"`;
}

// ───────────────────── helpers ─────────────────────

async function streamToBuffer(stream: ReadableStream, hint: number): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total || hint || 0);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

// Strip tags + collapse whitespace. Crude but adequate for the
// fallback case — most clients send a text/plain part.
function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

function kb(n: number): string {
  return `${Math.round(n / 1024)}kb`;
}
