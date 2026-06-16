// Unit tests for the harness adapters' pure translation logic — feed
// translateOutbound the on-wire frames each harness emits and assert on
// the pi-shaped events that come back. No process spawning; the file
// covers hermes (JSON-RPC) and codex (JSONL). Run: `bun test`.

import { test, expect } from "bun:test";
import {
  hermesAdapter,
  codexAdapter,
  claudeCodeAdapter,
  piAdapter,
  extractCodexJsonText,
  extractCodexThreadId,
  getAdapter,
  type AdapterHost,
} from "./harness-adapters";

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

// ─── codex ────────────────────────────────────────────────────────────
//
// codex is per-turn: each prompt spawns a fresh ssh+codex via buildTurnCmd,
// and multi-turn rides on `codex exec resume <thread_id>` — the id captured
// from a thread.started event on stdout. The state that matters is
// sess.codexThreadId between turns; the events that matter are
// thread.started (capture id), item.completed/agent_message (text payload),
// turn.completed (clean end), and turn.failed (terminal error).

test("getAdapter('codex') returns the codex adapter in per-turn mode", () => {
  expect(getAdapter("codex")).toBe(codexAdapter);
  expect(codexAdapter.mode).toBe("per-turn");
});

test("codex translateOutbound: thread.started captures the thread id silently", () => {
  const host = makeHost();
  const out = codexAdapter.translateOutbound(host, JSON.stringify({
    type: "thread.started", thread_id: "th-abc-123",
  }));
  expect(out).toEqual({ lines: [], ready: false });
  expect(host.codexThreadId).toBe("th-abc-123");
});

test("codex translateOutbound: thread.started with no thread_id is ignored", () => {
  const host = makeHost();
  const out = codexAdapter.translateOutbound(host, JSON.stringify({
    type: "thread.started",
  }));
  expect(out).toEqual({ lines: [], ready: false });
  expect(host.codexThreadId).toBeNull();
});

test("codex translateOutbound: item.completed/agent_message emits one text_delta", () => {
  const host = makeHost();
  const out = codexAdapter.translateOutbound(host, JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "hello from codex" },
  }));
  expect(out.ready).toBe(false);
  expect(out.lines.length).toBe(1);
  expect(JSON.parse(out.lines[0])).toEqual({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello from codex" },
  });
});

test("codex translateOutbound: item.completed for non-agent_message items is dropped", () => {
  const host = makeHost();
  // reasoning / command items carry nothing the talk CLI renders.
  expect(codexAdapter.translateOutbound(host, JSON.stringify({
    type: "item.completed", item: { type: "reasoning", text: "thinking…" },
  }))).toEqual({ lines: [], ready: false });
  expect(codexAdapter.translateOutbound(host, JSON.stringify({
    type: "item.completed", item: { type: "command", command: "ls" },
  }))).toEqual({ lines: [], ready: false });
});

test("codex translateOutbound: turn.completed → pi agent_end", () => {
  const host = makeHost();
  const out = codexAdapter.translateOutbound(host, JSON.stringify({
    type: "turn.completed",
  }));
  expect(JSON.parse(out.lines[0])).toEqual({ type: "agent_end" });
});

test("codex translateOutbound: turn.failed → pi response with success:false", () => {
  const host = makeHost();
  const out = codexAdapter.translateOutbound(host, JSON.stringify({
    type: "turn.failed", error: { message: "rate limited" },
  }));
  const ev = JSON.parse(out.lines[0]);
  expect(ev.type).toBe("response");
  expect(ev.success).toBe(false);
  expect(ev.error).toContain("rate limited");
});

test("codex translateOutbound: turn.failed without an error message uses a default", () => {
  const host = makeHost();
  const out = codexAdapter.translateOutbound(host, JSON.stringify({
    type: "turn.failed",
  }));
  expect(JSON.parse(out.lines[0]).error).toBe("codex error");
});

test("codex translateOutbound: error event is transient — logged, never surfaced", () => {
  const host = makeHost();
  const logs: string[] = [];
  host.log = (m: string) => { logs.push(m); };
  const out = codexAdapter.translateOutbound(host, JSON.stringify({
    type: "error", message: "transient connection drop",
  }));
  expect(out).toEqual({ lines: [], ready: false });
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("codex transient");
  expect(logs[0]).toContain("transient connection drop");
});

test("codex translateOutbound: non-JSON and unknown events are ignored", () => {
  const host = makeHost();
  expect(codexAdapter.translateOutbound(host, "not json")).toEqual({ lines: [], ready: false });
  expect(codexAdapter.translateOutbound(host, JSON.stringify({
    type: "turn.started",
  }))).toEqual({ lines: [], ready: false });
  expect(codexAdapter.translateOutbound(host, JSON.stringify({
    type: "usage", input_tokens: 100,
  }))).toEqual({ lines: [], ready: false });
});

test("codex buildTurnCmd: no thread id → reads the birth-time cache then falls back to fresh exec", () => {
  const host = makeHost();
  const cmd = codexAdapter.buildTurnCmd!(host, "say hi");
  // No in-memory thread → command must include the cache-file resume path.
  expect(cmd).toContain("/root/.cell/codex-main-thread");
  expect(cmd).toContain("codex exec resume");
  expect(cmd).toContain("codex exec --json"); // fresh fallback
  expect(cmd).toContain("--skip-git-repo-check");
  expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  // Prompt rides as bash's $1 (one positional arg, single-quoted).
  expect(cmd).toContain("'say hi'");
});

test("codex buildTurnCmd: in-memory thread id → resume that id, skip the cache fallback", () => {
  const host = makeHost();
  host.codexThreadId = "th-resumed-99";
  const cmd = codexAdapter.buildTurnCmd!(host, "next turn");
  expect(cmd).toContain("codex exec resume th-resumed-99");
  // The cache-file branch is the no-id fallback — must NOT appear when an
  // in-memory id is set.
  expect(cmd).not.toContain("/root/.cell/codex-main-thread");
  expect(cmd).toContain("'next turn'");
});

test("codex buildTurnCmd: prompts with single quotes are escaped (no shell-injection seam)", () => {
  const host = makeHost();
  const cmd = codexAdapter.buildTurnCmd!(host, "it's a quote-y prompt");
  // The single quote inside the prompt gets escaped as '\'' (close + escaped + reopen).
  expect(cmd).toContain("'it'\\''s a quote-y prompt'");
});

test("extractCodexJsonText: pulls the latest agent_message text out of a JSONL stream", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  expect(extractCodexJsonText(stdout)).toBe("final");
});

test("extractCodexJsonText: returns null when no agent_message is emitted", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  expect(extractCodexJsonText(stdout)).toBeNull();
});

test("extractCodexJsonText: skips non-JSON / non-object lines without throwing", () => {
  const stdout = [
    "warning: connecting to codex…",
    "",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
    "trailing garbage {not json",
  ].join("\n");
  expect(extractCodexJsonText(stdout)).toBe("answer");
});

// extractCodexThreadId — a named codex session persists this id from the
// FIRST turn (thread.started) so later turns `codex exec resume <id>`.
test("extractCodexThreadId: pulls thread_id from the thread.started event", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "th_abc123" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  expect(extractCodexThreadId(stdout)).toBe("th_abc123");
});

test("extractCodexThreadId: returns null when no thread.started is present", () => {
  const stdout = [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
  ].join("\n");
  expect(extractCodexThreadId(stdout)).toBeNull();
});

test("extractCodexThreadId: ignores a thread.started without a string thread_id, and survives garbage", () => {
  const stdout = [
    "starting codex…",
    JSON.stringify({ type: "thread.started" }), // no thread_id
    "{ not json",
    JSON.stringify({ type: "thread.started", thread_id: "th_real" }),
  ].join("\n");
  expect(extractCodexThreadId(stdout)).toBe("th_real");
});

// askInSession presence is the per-adapter "supports named sessions"
// capability the supervisor folds into NAMED_SESSIONS. pi/codex/claude have
// it (durable per-turn or pool); hermes has no named-session primitive.
test("askInSession capability: present on pi/codex/claude, absent on hermes", () => {
  expect(typeof piAdapter.askInSession).toBe("function");
  expect(typeof codexAdapter.askInSession).toBe("function");
  expect(typeof claudeCodeAdapter.askInSession).toBe("function");
  expect(hermesAdapter.askInSession).toBeUndefined();
});

// Defense in depth: the supervisor validates the session name, but each
// adapter turns it into a filesystem path, so a bad name must be rejected
// before any spawn (no traversal, no empty path segment).
test("askInSession rejects an invalid session name before spawning", async () => {
  for (const bad of ["../escape", "Buyer", "", "has space", "a".repeat(40)]) {
    const rPi = await piAdapter.askInSession!({ prompt: "x", session: bad, cellName: "c" });
    expect(rPi.ok).toBe(false);
    const rCodex = await codexAdapter.askInSession!({ prompt: "x", session: bad, cellName: "c" });
    expect(rCodex.ok).toBe(false);
    const rClaude = await claudeCodeAdapter.askInSession!({ prompt: "x", session: bad, cellName: "c" });
    expect(rClaude.ok).toBe(false);
  }
});

test("codex thread id survives a full turn cycle (capture → resume)", () => {
  // Simulate the lifecycle: first turn (no id) captures thread.started,
  // second turn resumes it.
  const host = makeHost();
  expect(host.codexThreadId).toBeNull();
  // First turn — no id yet.
  const cmd1 = codexAdapter.buildTurnCmd!(host, "turn 1");
  expect(cmd1).toContain("/root/.cell/codex-main-thread");
  // Outbound stream from that turn:
  codexAdapter.translateOutbound(host, JSON.stringify({
    type: "thread.started", thread_id: "th-fresh-1",
  }));
  codexAdapter.translateOutbound(host, JSON.stringify({
    type: "item.completed", item: { type: "agent_message", text: "hi" },
  }));
  codexAdapter.translateOutbound(host, JSON.stringify({ type: "turn.completed" }));
  expect(host.codexThreadId).toBe("th-fresh-1");
  // Second turn — must resume the captured id.
  const cmd2 = codexAdapter.buildTurnCmd!(host, "turn 2");
  expect(cmd2).toContain("codex exec resume th-fresh-1");
  expect(cmd2).not.toContain("/root/.cell/codex-main-thread");
});

// ─── claude-code ──────────────────────────────────────────────────────
//
// claude-code is persistent over stdio: `claude --print` with stream-json
// in/out. The handshake is a no-op (claude doesn't emit until it gets
// input, so we mark ready immediately so the queued prompt flushes).
// system/init from claude becomes our actual "up" signal; assistant
// content blocks translate to pi text_delta / thinking events; result
// caps the turn with agent_end or a response failure.

test("getAdapter('claude-code') returns the claude-code adapter in persistent mode", () => {
  expect(getAdapter("claude-code")).toBe(claudeCodeAdapter);
  expect(claudeCodeAdapter.mode).toBe("persistent");
});

test("claude-code buildRemoteCmd exports HOME=/root + IS_SANDBOX, resumes the cached main session", () => {
  const cmd = claudeCodeAdapter.buildRemoteCmd!("/unused/session/dir");
  expect(cmd).toContain("HOME=/root");
  expect(cmd).toContain("IS_SANDBOX=1");
  expect(cmd).toContain("claude --print");
  expect(cmd).toContain("--input-format stream-json");
  expect(cmd).toContain("--output-format stream-json");
  expect(cmd).toContain("--permission-mode bypassPermissions");
  expect(cmd).toContain("/root/.cell/claude-main-session");
  expect(cmd).toContain("--resume");
});

test("claude-code startHandshake flips ready immediately via onPiSetupAcked", () => {
  let acked = false;
  const host = makeHost();
  host.onPiSetupAcked = () => { acked = true; };
  claudeCodeAdapter.startHandshake!(host, "/unused");
  expect(acked).toBe(true);
});

test("claude-code translateOutbound: system/init flips ready, emits nothing", () => {
  const host = makeHost();
  const out = claudeCodeAdapter.translateOutbound(host, JSON.stringify({
    type: "system", subtype: "init", session_id: "abc",
  }));
  expect(out).toEqual({ lines: [], ready: true });
});

test("claude-code translateOutbound: assistant with a single text block → one text_delta", () => {
  const host = makeHost();
  const out = claudeCodeAdapter.translateOutbound(host, JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi from claude" }] },
  }));
  expect(out.ready).toBe(false);
  expect(out.lines.length).toBe(1);
  expect(JSON.parse(out.lines[0])).toEqual({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hi from claude" },
  });
});

test("claude-code translateOutbound: assistant with a thinking block → thinking_start + thinking_end", () => {
  const host = makeHost();
  const out = claudeCodeAdapter.translateOutbound(host, JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: "…hmm…" }] },
  }));
  // The adapter emits start + end as a paired envelope so the talk UI
  // can render a thinking spinner around it; the body text isn't passed
  // through (claude's thinking content is opaque to the user-facing UI).
  expect(out.lines.length).toBe(2);
  expect(JSON.parse(out.lines[0])).toEqual({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_start" },
  });
  expect(JSON.parse(out.lines[1])).toEqual({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end" },
  });
});

test("claude-code translateOutbound: assistant with mixed text + thinking blocks → both translated", () => {
  const host = makeHost();
  const out = claudeCodeAdapter.translateOutbound(host, JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "weighing" },
        { type: "text", text: "answer" },
      ],
    },
  }));
  expect(out.lines.length).toBe(3);
  expect(JSON.parse(out.lines[0]).assistantMessageEvent.type).toBe("thinking_start");
  expect(JSON.parse(out.lines[1]).assistantMessageEvent.type).toBe("thinking_end");
  expect(JSON.parse(out.lines[2]).assistantMessageEvent.delta).toBe("answer");
});

test("claude-code translateOutbound: result success → agent_end", () => {
  const host = makeHost();
  const out = claudeCodeAdapter.translateOutbound(host, JSON.stringify({
    type: "result", subtype: "success", is_error: false,
  }));
  expect(JSON.parse(out.lines[0])).toEqual({ type: "agent_end" });
});

test("claude-code translateOutbound: result with is_error → response success:false", () => {
  const host = makeHost();
  const out = claudeCodeAdapter.translateOutbound(host, JSON.stringify({
    type: "result", subtype: "error", is_error: true, result: "auth fail",
  }));
  const ev = JSON.parse(out.lines[0]);
  expect(ev.type).toBe("response");
  expect(ev.success).toBe(false);
  expect(ev.error).toContain("auth fail");
});

test("claude-code translateOutbound: result with non-success subtype → response failure even without is_error", () => {
  const host = makeHost();
  const out = claudeCodeAdapter.translateOutbound(host, JSON.stringify({
    type: "result", subtype: "max_turns_exceeded",
  }));
  expect(JSON.parse(out.lines[0]).success).toBe(false);
});

test("claude-code translateOutbound: user replays / rate-limit envelopes / partials → ignored", () => {
  const host = makeHost();
  expect(claudeCodeAdapter.translateOutbound(host, "not json")).toEqual({ lines: [], ready: false });
  expect(claudeCodeAdapter.translateOutbound(host, JSON.stringify({
    type: "user", message: { role: "user", content: "echo" },
  }))).toEqual({ lines: [], ready: false });
  expect(claudeCodeAdapter.translateOutbound(host, JSON.stringify({
    type: "stream_event", event: { type: "ping" },
  }))).toEqual({ lines: [], ready: false });
});

test("claude-code translateInbound: prompt → stream-json user envelope", () => {
  const host = makeHost();
  const line = claudeCodeAdapter.translateInbound!({
    type: "prompt", message: "hi there",
  }, host);
  expect(line).not.toBeNull();
  expect(JSON.parse(line!)).toEqual({
    type: "user",
    message: { role: "user", content: "hi there" },
  });
});

test("claude-code translateInbound: non-prompt commands → null (no claude equivalent)", () => {
  const host = makeHost();
  expect(claudeCodeAdapter.translateInbound!({ type: "abort" }, host)).toBeNull();
  expect(claudeCodeAdapter.translateInbound!({ type: "ping" }, host)).toBeNull();
  expect(claudeCodeAdapter.translateInbound!({ type: "set_model", model: "opus" }, host)).toBeNull();
});

// ─── pi ───────────────────────────────────────────────────────────────
//
// pi is the native harness: its RPC vocabulary IS the talk CLI's
// vocabulary, so translateOutbound passes lines through unchanged.
// The only translation work is the startup pin: handshake writes a
// switch_session pointing at the cell's main.jsonl, and the matching
// ack response flips ready. translateInbound just JSON.stringifies the
// incoming command.

test("getAdapter('pi') returns the pi adapter in persistent mode", () => {
  expect(getAdapter("pi")).toBe(piAdapter);
  expect(piAdapter.mode).toBe("persistent");
});

test("pi buildRemoteCmd exports HOME=/root and runs pi rpc against the session dir", () => {
  const cmd = piAdapter.buildRemoteCmd!("/sessions/cells/alice");
  expect(cmd).toContain("HOME=/root");
  expect(cmd).toContain("pi --mode rpc");
  expect(cmd).toContain("--session-dir /sessions/cells/alice");
  expect(cmd).toContain("cd /root");
  // The session-dir directory is created with sudo before the exec —
  // otherwise pi crashes on a fresh cell's first spawn.
  expect(cmd).toContain("sudo mkdir -p /sessions/cells/alice");
});

test("pi startHandshake schedules a switch_session pin and arms the ack tracker", async () => {
  const host = makeHost();
  piAdapter.startHandshake!(host, "/sessions/cells/alice");
  // The ack tracker is armed synchronously so an ack arriving before
  // setTimeout fires would still match.
  expect(host.awaitingSwitchAck).not.toBeNull();
  expect(host.awaitingSwitchAck).toMatch(/^bridge-init-/);
  expect(host.writes.length).toBe(0); // setTimeout hasn't fired yet
  // Wait past the 250ms delay and confirm the switch_session went out.
  await new Promise((r) => setTimeout(r, 300));
  expect(host.writes.length).toBe(1);
  const rpc = JSON.parse(host.writes[0]);
  expect(rpc.type).toBe("switch_session");
  expect(rpc.sessionPath).toBe("/sessions/cells/alice/main.jsonl");
  expect(rpc.id).toBe(host.awaitingSwitchAck);
});

test("pi translateOutbound: pi-native frames pass through unchanged with ready:false", () => {
  const host = makeHost();
  const frame = JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  expect(piAdapter.translateOutbound(host, frame)).toEqual({ lines: [frame], ready: false });
});

test("pi translateOutbound: matching switch_session ack flips ready and clears the tracker", () => {
  const host = makeHost();
  host.awaitingSwitchAck = "bridge-init-42";
  const ack = JSON.stringify({
    id: "bridge-init-42",
    type: "response",
    command: "switch_session",
    success: true,
  });
  const out = piAdapter.translateOutbound(host, ack);
  expect(out.ready).toBe(true);
  // pi's stream is the talk vocabulary — the ack still gets broadcast
  // so the talk CLI can see it. Bridge-side state just got updated.
  expect(out.lines).toEqual([ack]);
  expect(host.awaitingSwitchAck).toBeNull();
});

test("pi translateOutbound: switch_session ack with a different id does NOT flip ready", () => {
  const host = makeHost();
  host.awaitingSwitchAck = "bridge-init-42";
  const wrongAck = JSON.stringify({
    id: "bridge-init-99",
    type: "response",
    command: "switch_session",
  });
  const out = piAdapter.translateOutbound(host, wrongAck);
  expect(out.ready).toBe(false);
  expect(host.awaitingSwitchAck).toBe("bridge-init-42");
});

test("pi translateOutbound: non-JSON lines still broadcast (don't drop diagnostic stderr)", () => {
  const host = makeHost();
  const noise = "warning: pi probably-fine reconnect";
  expect(piAdapter.translateOutbound(host, noise)).toEqual({ lines: [noise], ready: false });
});

test("pi translateInbound: any command is JSON.stringified verbatim", () => {
  const host = makeHost();
  const cmd = { type: "prompt", message: "hi", id: "p1" };
  expect(piAdapter.translateInbound!(cmd, host)).toBe(JSON.stringify(cmd));
  expect(piAdapter.translateInbound!({ type: "abort" }, host)).toBe('{"type":"abort"}');
});

// Fork leash sizing from the sender's declared budget (envelope
// timeout_seconds via the DO). The constants are load-bearing: the floor
// protects against pathological tiny stamps, the ceiling against a fork
// pinned forever — see the advisor-pete onboarding kill, 2026-06-11.
import { turnLeashMs, TURN_LEASH_FLOOR_MS, TURN_LEASH_CEILING_MS } from "./harness-adapters";

test("turnLeashMs honors a sane sender budget verbatim (180s CLI default)", () => {
  expect(turnLeashMs(180_000)).toBe(180_000);
});
test("turnLeashMs floors tiny budgets at 60s", () => {
  expect(turnLeashMs(5_000)).toBe(TURN_LEASH_FLOOR_MS);
});
test("turnLeashMs ceilings runaway budgets at 15 min", () => {
  expect(turnLeashMs(86_400_000)).toBe(TURN_LEASH_CEILING_MS);
});
test("turnLeashMs: zero / negative / NaN fall to the floor", () => {
  expect(turnLeashMs(0)).toBe(TURN_LEASH_FLOOR_MS);
  expect(turnLeashMs(-5)).toBe(TURN_LEASH_FLOOR_MS);
  expect(turnLeashMs(Number.NaN)).toBe(TURN_LEASH_FLOOR_MS);
});
