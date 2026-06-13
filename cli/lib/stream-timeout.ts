// First-byte timeout for proxied LLM streams.
//
// Symptom (docs/BACKLOG.md, from homezero): a `claude --print --resume`
// request proxied to Anthropic opened a streaming socket that produced ZERO
// output tokens — no frames ever — and nothing detected it; one process sat
// wedged 23h40m. The proxy passed `upstream.body` straight to the client with
// no observation of whether bytes ever flowed.
//
// Two failure shapes, both guarded (in proxy.ts) for STREAMING requests only —
// a non-streaming request legitimately takes minutes to its first byte (the
// whole response is sent after generation), so these guards must never apply
// to it:
//   1. Headers never arrive — `fetch()` never resolves. Guarded by an
//      AbortController + headers timeout around the fetch (in proxy.ts).
//   2. Headers arrive but the body never emits a first byte. Guarded here:
//      wrap the body so it errors (and the caller aborts the upstream socket)
//      if no chunk arrives within the timeout.

export interface FirstByteTimeoutOpts {
  timeoutMs: number;
  // Called once if the first byte doesn't arrive in time — the caller aborts
  // the upstream fetch (tearing down the wedged socket) and logs.
  onTimeout: () => void;
}

// Wrap a body stream so it errors if no first byte arrives within timeoutMs.
// The timer starts when the wrapped stream begins and is cleared on the first
// chunk; a healthy stream is passed through transparently with one timer set
// and cleared. Acquires the source reader exactly once (the agent's first
// draft re-acquired it per pull, which throws on a locked stream).
export function firstByteTimeoutStream(
  source: ReadableStream<Uint8Array>,
  opts: FirstByteTimeoutOpts,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let firstByteSeen = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        timedOut = true;
        clearTimer();
        try {
          opts.onTimeout();
        } catch {
          /* logging/abort best-effort */
        }
        try {
          controller.error(new Error("first-byte-timeout"));
        } catch {
          /* already closed */
        }
        reader.cancel().catch(() => {});
      }, opts.timeoutMs);
    },
    async pull(controller) {
      if (timedOut) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimer();
          controller.close();
          return;
        }
        if (!firstByteSeen) {
          firstByteSeen = true;
          clearTimer();
        }
        controller.enqueue(value);
      } catch (e) {
        clearTimer();
        controller.error(e as Error);
      }
    },
    cancel(reason) {
      clearTimer();
      return reader.cancel(reason);
    },
  });
}

// Does this request ask for a streaming (SSE) response? Both Anthropic
// (/v1/messages) and OpenAI (/responses) use `"stream": true`. The body is
// already buffered for the 401-retry, so parsing it here is free. Returns
// false on a missing/unparseable body (GET/HEAD, non-JSON) — those never get
// the streaming guards.
export function requestWantsStream(
  bodyBytes: Uint8Array | null | undefined,
): boolean {
  if (!bodyBytes || bodyBytes.length === 0) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as {
      stream?: unknown;
    };
    return parsed?.stream === true;
  } catch {
    return false;
  }
}
