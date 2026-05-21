// Unit tests for the hermes harness adapter — the JSON-RPC ⇄ pi-event
// translation. Pure logic, no process spawning: feed translateOutbound the
// gateway frames hermes emits and translateInbound the pi-RPC commands the
// talk CLI sends, and assert on what comes back. Run: `bun test`.

import { test, expect } from "bun:test";
import { hermesAdapter, getAdapter, type AdapterHost } from "./harness-adapters";

// Minimal AdapterHost stub — captures writeLine output for assertions.
function makeHost(): AdapterHost & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    codexThreadId: null,
    awaitingSwitchAck: null,
    hermesSessionId: null,
    writeLine: (line: string) => { writes.push(line); return true; },
    log: () => {},
    err: () => {},
    onPiSetupAcked: () => {},
  };
}

test("getAdapter('hermes') returns the hermes adapter, persistent mode", () => {
  expect(getAdapter("hermes")).toBe(hermesAdapter);
  expect(hermesAdapter.mode).toBe("persistent");
});

test("buildRemoteCmd launches the gateway unbuffered from the hermes venv", () => {
  const cmd = hermesAdapter.buildRemoteCmd!("/unused/session/dir");
  expect(cmd).toContain("/usr/local/lib/hermes-agent/venv/bin/python");
  expect(cmd).toContain("-u -m tui_gateway.entry");
  expect(cmd).toContain("HERMES_PYTHON_SRC_ROOT=");
});

test("handshake: gateway.ready triggers a session.create RPC", () => {
  const host = makeHost();
  const out = hermesAdapter.translateOutbound(host, JSON.stringify({
    jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} },
  }));
  expect(out).toEqual({ lines: [], ready: false });
  expect(host.writes.length).toBe(1);
  const rpc = JSON.parse(host.writes[0]);
  expect(rpc.method).toBe("session.create");
  expect(rpc.id).toBe("cells-session");
});

test("handshake: session.create response captures the session id and flips ready", () => {
  const host = makeHost();
  const out = hermesAdapter.translateOutbound(host, JSON.stringify({
    jsonrpc: "2.0", id: "cells-session", result: { session_id: "ab12cd34" },
  }));
  expect(out.ready).toBe(true);
  expect(out.lines).toEqual([]);
  expect(host.hermesSessionId).toBe("ab12cd34");
});

test("handshake: a failed session.create stays not-ready", () => {
  const host = makeHost();
  const out = hermesAdapter.translateOutbound(host, JSON.stringify({
    jsonrpc: "2.0", id: "cells-session", error: { code: 5000, message: "db down" },
  }));
  expect(out.ready).toBe(false);
  expect(host.hermesSessionId).toBeNull();
});

test("message.delta → pi text_delta event", () => {
  const host = makeHost();
  const out = hermesAdapter.translateOutbound(host, JSON.stringify({
    jsonrpc: "2.0", method: "event",
    params: { type: "message.delta", session_id: "ab12cd34", payload: { text: "hello" } },
  }));
  expect(out.ready).toBe(false);
  expect(out.lines.length).toBe(1);
  expect(JSON.parse(out.lines[0])).toEqual({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  });
});

test("message.complete (ok) → agent_end", () => {
  const host = makeHost();
  const out = hermesAdapter.translateOutbound(host, JSON.stringify({
    jsonrpc: "2.0", method: "event",
    params: { type: "message.complete", session_id: "x", payload: { status: "complete", text: "done" } },
  }));
  expect(JSON.parse(out.lines[0])).toEqual({ type: "agent_end" });
});

test("message.complete (error) → response failure carrying the message", () => {
  const host = makeHost();
  const out = hermesAdapter.translateOutbound(host, JSON.stringify({
    jsonrpc: "2.0", method: "event",
    params: { type: "message.complete", session_id: "x", payload: { status: "error", text: "boom" } },
  }));
  const ev = JSON.parse(out.lines[0]);
  expect(ev.type).toBe("response");
  expect(ev.success).toBe(false);
  expect(ev.error).toContain("boom");
});

test("error event → response failure", () => {
  const host = makeHost();
  const out = hermesAdapter.translateOutbound(host, JSON.stringify({
    jsonrpc: "2.0", method: "event",
    params: { type: "error", session_id: "x", payload: { message: "kaboom" } },
  }));
  const ev = JSON.parse(out.lines[0]);
  expect(ev.success).toBe(false);
  expect(ev.error).toContain("kaboom");
});

test("translateOutbound ignores non-JSON and unrendered events", () => {
  const host = makeHost();
  expect(hermesAdapter.translateOutbound(host, "not json")).toEqual({ lines: [], ready: false });
  expect(hermesAdapter.translateOutbound(host, JSON.stringify({
    jsonrpc: "2.0", method: "event", params: { type: "message.start", session_id: "x" },
  }))).toEqual({ lines: [], ready: false });
  expect(hermesAdapter.translateOutbound(host, JSON.stringify({
    jsonrpc: "2.0", method: "event", params: { type: "tool.start", session_id: "x", payload: {} },
  }))).toEqual({ lines: [], ready: false });
});

test("translateInbound: prompt → prompt.submit carrying the session id", () => {
  const host = makeHost();
  host.hermesSessionId = "ab12cd34";
  const line = hermesAdapter.translateInbound!({ type: "prompt", message: "hi there", id: "p1" }, host);
  expect(line).not.toBeNull();
  const rpc = JSON.parse(line!);
  expect(rpc.method).toBe("prompt.submit");
  expect(rpc.params).toEqual({ session_id: "ab12cd34", text: "hi there" });
});

test("translateInbound: prompt before handshake → null (host-bridge re-queues raw)", () => {
  const host = makeHost(); // hermesSessionId still null
  expect(hermesAdapter.translateInbound!({ type: "prompt", message: "hi" }, host)).toBeNull();
});

test("translateInbound: abort → session.interrupt", () => {
  const host = makeHost();
  host.hermesSessionId = "ab12cd34";
  const rpc = JSON.parse(hermesAdapter.translateInbound!({ type: "abort" }, host)!);
  expect(rpc.method).toBe("session.interrupt");
  expect(rpc.params.session_id).toBe("ab12cd34");
});

test("translateInbound: commands with no gateway equivalent → null", () => {
  const host = makeHost();
  host.hermesSessionId = "ab12cd34";
  expect(hermesAdapter.translateInbound!({ type: "ping" }, host)).toBeNull();
  expect(hermesAdapter.translateInbound!({ type: "set_model", model: "x" }, host)).toBeNull();
});
