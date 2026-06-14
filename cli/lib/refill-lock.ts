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
//
// Scope — this is best-effort COALESCING, not a hard mutex. Race-free
// reclamation of a crashed holder's lock is impossible with O_EXCL + rename
// alone (it needs OS advisory locks / flock, which Bun doesn't expose without
// FFI — not worth a control-plane dependency whose failure would break every
// refill). The implementation below is correct for every realistic case (0/1/2
// reclaimers of a crashed holder; a live holder is NEVER stolen); only a
// pathological 3-process, sub-millisecond steal-during-stale-recovery race can
// still let two loops run. That residual is benign: the worst case is one
// extra concurrent bake, and overshoot past target is already cleaned by
// reconcile's over-target cull. So the HARD invariant (pool never grows
// without bound) lives in reconcile; this lock just eliminates the common,
// non-racy redundant-refill case (the seal-contention driver we saw live).

import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

// O_CREAT|O_EXCL create: succeeds only if the path doesn't already exist, so
// at most one racer wins. Returns whether we created (and now own) the lock.
function tryCreate(lockPath: string, now: number): boolean {
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: now }), {
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}

// A holder is stale (reclaimable) if it's malformed, its pid is dead, or it's
// older than the backstop. A live, recent holder is a running refill.
function isStale(holder: RefillLockHolder | null, now: number): boolean {
  if (!holder) return true; // malformed/empty → reclaimable
  const recent = holder.at != null && now - holder.at < REFILL_LOCK_STALE_MS;
  const live = holder.pid == null || pidAlive(holder.pid);
  return !(recent && live);
}

// Try to acquire. Returns true if the caller now owns the lock (run the
// refill), false if a live refill already holds it (skip). `now`/`lockPath`
// are injectable for tests. Reclaims a lock whose holder pid is dead or older
// than the backstop, without ever stealing a live holder's lock.
export function tryAcquireRefillLock(
  now: number = Date.now(),
  lockPath: string = REFILL_LOCK_PATH,
): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });

  // Fast path: no lock yet → claim it atomically.
  if (tryCreate(lockPath, now)) return true;

  // A lock exists; a live, recent holder means a refill is already running.
  if (!isStale(refillLockHolder(lockPath), now)) return false;

  // Stale (crashed holder, or alive-but-wedged past the backstop). Move it
  // aside ATOMICALLY — rename of a given path has exactly one winner, the rest
  // get ENOENT and coalesce.
  const tmp = `${lockPath}.stale.${process.pid}.${now}`;
  try {
    renameSync(lockPath, tmp);
  } catch {
    return false; // another reclaimer moved it first — let them run
  }

  // Verify what we actually grabbed. Between our staleness read and the rename,
  // the stale holder's lock could have been reclaimed AND a fresh lock created
  // by another process — in which case we just moved a LIVE owner's lock aside
  // (codex P2). If so, put it back and coalesce; never run two refills. Only
  // when the moved lock is confirmed stale do we discard it and take over.
  const moved = refillLockHolder(tmp);
  if (isStale(moved, now)) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return tryCreate(lockPath, now); // loses to a racer that created in the gap
  }
  // We grabbed a fresh lock — restore it for its live owner and coalesce.
  // linkSync (not rename) so we never CLOBBER a lock created at lockPath under
  // us: it fails if the path is occupied again, in which case that new lock
  // stands and we just drop our moved copy. Either way we never run a refill.
  try {
    linkSync(tmp, lockPath);
  } catch {
    /* lockPath already re-taken — leave it; our copy gets dropped below */
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  return false;
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
