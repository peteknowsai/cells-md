/**
 * Named-session pool — pure seams. The entire VM-independent risk surface of
 * the warm interactive talk rewrite is these functions; the live tail, queue,
 * and tmux lifecycle in server.ts are built on top of them.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SESSION,
  IDLE_TTL_MS,
  MAIN_SESSION_FILE,
  SESSIONS_DIR,
  WARM_CAP,
  idleEvictDue,
  isTerminalAnswer,
  lastTurnFinal,
  lruEvictTarget,
  parseJsonl,
  parseTranscriptDelta,
  sessionFlags,
  sessionIdPath,
  transcriptPathForId,
  validateSessionName,
} from "./session-pool";

const asst = (text: string, stop = "end_turn") => ({
  type: "assistant",
  message: { content: [{ type: "text", text }], stop_reason: stop },
});
const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });

describe("validateSessionName", () => {
  test("accepts main, buyer, staff", () => {
    expect(validateSessionName("main")).toBe("main");
    expect(validateSessionName("buyer")).toBe("buyer");
    expect(validateSessionName("staff")).toBe("staff");
    expect(validateSessionName("a_b-9")).toBe("a_b-9");
  });
  test("rejects traversal, separators, uppercase, leading digit, empty, overlong, non-string", () => {
    for (const bad of [
      "../etc",
      "a/b",
      "a.b",
      "..",
      "Main",
      "9lives",
      "",
      "-x",
      "_x",
      "a".repeat(33),
      null,
      undefined,
      42,
    ]) {
      expect(validateSessionName(bad as unknown)).toBeNull();
    }
  });
});

describe("sessionIdPath", () => {
  test("main aliases the legacy pin", () => {
    expect(sessionIdPath("main")).toBe(MAIN_SESSION_FILE);
  });
  test("named sessions live under SESSIONS_DIR", () => {
    expect(sessionIdPath("buyer")).toBe(`${SESSIONS_DIR}/buyer`);
  });
  test("invalid names resolve to null (no path escape)", () => {
    expect(sessionIdPath("../../etc/passwd")).toBeNull();
    expect(sessionIdPath("a/b")).toBeNull();
  });
});

describe("sessionFlags", () => {
  test("resume a known id", () => {
    expect(sessionFlags("abc-123", "fresh-uuid")).toEqual({
      args: ["--resume", "abc-123"],
      created: false,
    });
  });
  test("create-on-first-use asserts the supplied uuid", () => {
    expect(sessionFlags(null, "fresh-uuid")).toEqual({
      args: ["--session-id", "fresh-uuid"],
      created: true,
    });
  });
});

describe("parseJsonl", () => {
  test("parses complete lines, skips blanks and torn JSON", () => {
    const text = `{"type":"user"}\n\n{"type":"assistant"}\n{"type":"asst", "tor`;
    const rows = parseJsonl(text);
    // the trailing torn line is dropped; two complete rows survive
    expect(rows).toEqual([{ type: "user" }, { type: "assistant" }]);
  });
  test("empty input → no rows", () => {
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl("\n\n")).toEqual([]);
  });
});

describe("parseTranscriptDelta", () => {
  test("assistant text block → one delta", () => {
    expect(parseTranscriptDelta([asst("hello")])).toEqual(["hello"]);
  });
  test("multiple text blocks → one delta each, in order", () => {
    const row = { type: "assistant", message: { content: [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ] } };
    expect(parseTranscriptDelta([row])).toEqual(["one", "two"]);
  });
  test("skips tool_use, tool_result, thinking, user rows, empty text", () => {
    const rows = [
      user("the prompt"),
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "out" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "" }] } },
      asst("final answer"),
    ];
    expect(parseTranscriptDelta(rows)).toEqual(["final answer"]);
  });
  test("a tool-only turn (no text yet) emits nothing", () => {
    const rows = [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }];
    expect(parseTranscriptDelta(rows)).toEqual([]);
  });
});

describe("lastTurnFinal", () => {
  test("last assistant after the last user row", () => {
    const rows = [
      asst("stale prior answer"), // inherited history, before the new prompt
      user("new prompt"),
      asst("the answer", "end_turn"),
    ];
    expect(lastTurnFinal(rows)).toEqual({ text: "the answer", stopReason: "end_turn" });
  });
  test("multi-tool turn: terminal answer after the last tool_result (a user row)", () => {
    const rows = [
      user("do the thing"),
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
      asst("done, here it is", "end_turn"),
    ];
    expect(lastTurnFinal(rows).text).toBe("done, here it is");
  });
  test("no assistant after the last user → empty", () => {
    expect(lastTurnFinal([user("hi")])).toEqual({ text: "", stopReason: "" });
  });
});

describe("isTerminalAnswer", () => {
  test("end_turn / stop_sequence with text are terminal", () => {
    expect(isTerminalAnswer("x", "end_turn")).toBe(true);
    expect(isTerminalAnswer("x", "stop_sequence")).toBe(true);
  });
  test("tool_use or empty text is not terminal", () => {
    expect(isTerminalAnswer("x", "tool_use")).toBe(false);
    expect(isTerminalAnswer("", "end_turn")).toBe(false);
  });
});

describe("idleEvictDue", () => {
  test("fires at exactly the TTL boundary", () => {
    expect(idleEvictDue(1000 + IDLE_TTL_MS, 1000, IDLE_TTL_MS)).toBe(true);
    expect(idleEvictDue(999 + IDLE_TTL_MS, 1000, IDLE_TTL_MS)).toBe(false);
  });
});

describe("lruEvictTarget", () => {
  const s = (name: string, state: any, lastTurnAt: number) => ({ name, state, lastTurnAt });
  test("under cap → nothing to evict", () => {
    expect(lruEvictTarget([s("main", "idle", 5), s("buyer", "busy", 9)], WARM_CAP)).toBeNull();
  });
  test("at cap → least-recently-used idle session", () => {
    const sessions = [s("main", "busy", 100), s("buyer", "idle", 50), s("staff", "idle", 20)];
    expect(lruEvictTarget(sessions, 3)).toBe("staff");
  });
  test("at cap but all busy → null (run over cap rather than kill a live turn)", () => {
    const sessions = [s("main", "busy", 1), s("buyer", "busy", 2), s("staff", "busy", 3)];
    expect(lruEvictTarget(sessions, 3)).toBeNull();
  });
  test("cold sessions don't count toward the cap", () => {
    const sessions = [s("main", "idle", 1), s("buyer", "cold", 2), s("staff", "cold", 3)];
    expect(lruEvictTarget(sessions, 3)).toBeNull();
  });
});

describe("constants", () => {
  test("default session + transcript path shape", () => {
    expect(DEFAULT_SESSION).toBe("main");
    expect(transcriptPathForId("abc")).toBe("/root/.claude/projects/-root/abc.jsonl");
  });
});
