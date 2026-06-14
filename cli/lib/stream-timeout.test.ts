import { describe, expect, test } from "bun:test";
import { firstByteTimeoutStream, requestWantsStream } from "./stream-timeout.ts";

const enc = (s: string) => new TextEncoder().encode(s);

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe("firstByteTimeoutStream", () => {
  test("passes a healthy stream through and never fires onTimeout", async () => {
    let timedOut = false;
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc("hello "));
        c.enqueue(enc("world"));
        c.close();
      },
    });
    const wrapped = firstByteTimeoutStream(src, {
      timeoutMs: 1000,
      onTimeout: () => {
        timedOut = true;
      },
    });
    expect(await drain(wrapped)).toBe("hello world");
    expect(timedOut).toBe(false);
  });

  test("errors and fires onTimeout when no first byte arrives in time", async () => {
    let timedOut = false;
    // A source that never enqueues anything (the wedge: zero tokens ever).
    const src = new ReadableStream<Uint8Array>({ start() { /* no data */ } });
    const wrapped = firstByteTimeoutStream(src, {
      timeoutMs: 80,
      onTimeout: () => {
        timedOut = true;
      },
    });
    await expect(drain(wrapped)).rejects.toThrow(/first-byte-timeout/);
    expect(timedOut).toBe(true);
  });

  test("a slow-but-present first byte before the deadline is not cut", async () => {
    let timedOut = false;
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        setTimeout(() => {
          c.enqueue(enc("late"));
          c.close();
        }, 40);
      },
    });
    const wrapped = firstByteTimeoutStream(src, {
      timeoutMs: 200,
      onTimeout: () => {
        timedOut = true;
      },
    });
    expect(await drain(wrapped)).toBe("late");
    expect(timedOut).toBe(false);
  });

  test("does not fire after the first byte even if later chunks are slow", async () => {
    let timedOut = false;
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc("a"));
        // Long gap AFTER the first byte — first-byte timer was already cleared,
        // so this must NOT trigger a timeout (long thinking pauses are normal).
        setTimeout(() => {
          c.enqueue(enc("b"));
          c.close();
        }, 60);
      },
    });
    const wrapped = firstByteTimeoutStream(src, {
      timeoutMs: 30,
      onTimeout: () => {
        timedOut = true;
      },
    });
    expect(await drain(wrapped)).toBe("ab");
    expect(timedOut).toBe(false);
  });
});

describe("requestWantsStream", () => {
  test("true for an explicit stream:true body", () => {
    expect(requestWantsStream(enc(JSON.stringify({ model: "x", stream: true })))).toBe(true);
  });
  test("false for stream:false / omitted", () => {
    expect(requestWantsStream(enc(JSON.stringify({ model: "x", stream: false })))).toBe(false);
    expect(requestWantsStream(enc(JSON.stringify({ model: "x" })))).toBe(false);
  });
  test("false for empty / missing / non-JSON body", () => {
    expect(requestWantsStream(undefined)).toBe(false);
    expect(requestWantsStream(null)).toBe(false);
    expect(requestWantsStream(new Uint8Array(0))).toBe(false);
    expect(requestWantsStream(enc("not json{"))).toBe(false);
  });
});
