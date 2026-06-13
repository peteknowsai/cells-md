import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryAcquireRefillLock,
  releaseRefillLock,
  refillLockHolder,
  REFILL_LOCK_STALE_MS,
} from "./refill-lock.ts";

let dir: string;
let lock: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "refill-lock-test-"));
  lock = join(dir, ".refill.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("refill single-flight lock", () => {
  test("first caller acquires, second caller coalesces (skips)", () => {
    expect(tryAcquireRefillLock(Date.now(), lock)).toBe(true);
    // A second acquire while we still hold it must fail (we are alive).
    expect(tryAcquireRefillLock(Date.now(), lock)).toBe(false);
    expect(tryAcquireRefillLock(Date.now(), lock)).toBe(false);
  });

  test("release lets the next caller acquire", () => {
    expect(tryAcquireRefillLock(Date.now(), lock)).toBe(true);
    releaseRefillLock(lock);
    expect(existsSync(lock)).toBe(false);
    expect(tryAcquireRefillLock(Date.now(), lock)).toBe(true);
  });

  test("steals a lock whose holder pid is dead", () => {
    // PID 0 is never a real userspace process → pidAlive(0) is false.
    writeFileSync(lock, JSON.stringify({ pid: 999999999, at: Date.now() }));
    // 999999999 is not a live pid → stale → steal.
    expect(tryAcquireRefillLock(Date.now(), lock)).toBe(true);
    expect(refillLockHolder(lock)?.pid).toBe(process.pid);
  });

  test("does NOT steal a fresh lock held by a live process", () => {
    // Our own live pid, recent timestamp → must not be stolen.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(tryAcquireRefillLock(Date.now(), lock)).toBe(false);
  });

  test("steals a lock older than the staleness backstop even if pid is live", () => {
    const old = Date.now() - REFILL_LOCK_STALE_MS - 1000;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: old }));
    // Live pid but ancient → wedged-holder backstop → steal.
    expect(tryAcquireRefillLock(Date.now(), lock)).toBe(true);
  });

  test("release only clears a lock we own (never another holder's)", () => {
    // Another process holds it.
    writeFileSync(lock, JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
    releaseRefillLock(lock);
    // We did not own it → it must still be there.
    expect(existsSync(lock)).toBe(true);
  });

  test("tolerates a malformed lock file", () => {
    writeFileSync(lock, "not json{");
    // Malformed holder → no recent/live holder → steal.
    expect(tryAcquireRefillLock(Date.now(), lock)).toBe(true);
    expect(refillLockHolder(lock)?.pid).toBe(process.pid);
  });
});
