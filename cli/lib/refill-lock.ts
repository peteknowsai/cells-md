// Non-blocking single-flight for the pool refill loop.
//
// refillPoolToDepth() is fired fire-and-forget from several triggers — the
// post-claim drought kick (one per birth), reconcile's shrink path, the
// `cells pool refill` subcommand, and the steward sweep. Each runs Pass 2's
// `while (open < target) await bakePoolMember()` loop. Without coalescing,
// two triggers in different processes each run that loop concurrently: each
// bakes toward target while the other's bakes are still in flight
// (countOpenPoolMembers lags ~2.5 min behind a bake), so they oversubscribe
// the host — the I/O contention that drove the seal-timeout failures — and
// overshoot target (the old code leaned on reconcile's cull to clean up the
// overshoot after the fact). The pre-existing pgrep-based isRefillInFlight()
// only saw the `cells pool refill` *subprocess* form and missed in-process
// calls, so it never caught two reconcile-driven refills racing.
//
// This lock is held for the whole loop. Unlike a birth lock (which queues),
// a refill that finds the lock held SKIPS: the running refill already drives
// the pool to target, so a second loop would only add load. Acquire returns
// true → run; false → no-op.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REFILL_LOCK_PATH } from "./paths.ts";

// A refill of an empty pool bakes up to the full target serially (~2.5 min
// per egg), so a live refill can legitimately hold the lock for ~15-20 min.
// pid-liveness is the primary staleness signal (a crashed holder is stolen
// immediately); this age backstop only covers a holder that is alive but
// wedged. Generous so it never steals from a genuinely-progressing refill.
export const REFILL_LOCK_STALE_MS = 30 * 60 * 1000;

interface RefillLockHolder {
  pid?: number;
  at?: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function refillLockHolder(
  lockPath: string = REFILL_LOCK_PATH,
): RefillLockHolder | null {
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8")) as RefillLockHolder;
  } catch {
    return null;
  }
}

// Try to acquire. Returns true if the caller now owns the lock (run the
// refill), false if a live refill already holds it (skip). `now`/`lockPath`
// are injectable for tests. Steals a lock whose holder pid is dead or older
// than the backstop.
export function tryAcquireRefillLock(
  now: number = Date.now(),
  lockPath: string = REFILL_LOCK_PATH,
): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const holder = refillLockHolder(lockPath);
    const recent = holder?.at != null && now - holder.at < REFILL_LOCK_STALE_MS;
    const live = holder?.pid == null || pidAlive(holder.pid);
    if (recent && live) return false; // a live refill holds it — coalesce
    try {
      unlinkSync(lockPath);
    } catch {
      /* vanished mid-steal — fall through to the O_EXCL create */
    }
  }
  try {
    // wx = O_CREAT|O_EXCL: fails if another process won the steal race.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: now }), {
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}

export function releaseRefillLock(lockPath: string = REFILL_LOCK_PATH): void {
  // Only clear a lock we still own — a stale-steal by another process may
  // have replaced it with theirs, which we must not delete.
  try {
    const holder = refillLockHolder(lockPath);
    if (holder?.pid === process.pid) unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}
