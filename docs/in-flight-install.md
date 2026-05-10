# In-flight install status surface

The cell-side state file that lets a hatched cell self-narrate while capabilities install in the background.

Per `docs/eggs-spec.md` Phase 4: when a `cells birth` request can't find an exact-match egg, hatch picks the closest egg and kicks off background install of the missing extensions/packages on the cell. The talk session is live during the install. The cell needs to *know* what's loading so its responses don't look broken.

## The problem

Without this surface:

```
user> can you grep my notes?
cell> Sure, let me search... [tool call: pi-web-access.fetch]
       [error: pi-web-access not installed]
cell> I encountered an error. Can you try again?
```

That's a broken cell. The user retries, hits the same error, gives up. They have no signal that the capability is *coming* in 20 seconds.

With this surface:

```
user> can you grep my notes?
cell> I'm still loading pi-web-access — install finishes in roughly
      30 seconds. Want me to retry then, or is there a non-web search
      I can do meanwhile?
```

That's a graceful cell. The user knows what's happening, can make a choice.

## The file

**Path**: `/cell/.pi/in-flight.json`. (Pre-migration cells on `~/agent/.pi/` are scheduled for kill-and-rebirth, not in-place migration — see `docs/cell-filesystem.md`.)

**Owner**: `cell:cell` (the cell user that pi runs as).

**Lifecycle**: written by hatch immediately after identity sed, read on every pi turn (via the system prompt extension below), updated by background install workers, deleted when all installs settle.

**Schema**:

```json
{
  "schema_version": 1,
  "hatched_at": "2026-05-10T01:23:45Z",
  "hatched_from_egg": "egg-7f3a",
  "extensions": [
    {
      "name": "wiki",
      "state": "installing",
      "started_at": "2026-05-10T01:23:48Z",
      "eta_seconds": 12,
      "log_path": "/cell/.pi/in-flight-logs/wiki.log"
    }
  ],
  "packages": [
    {
      "name": "pi-web-access",
      "state": "installing",
      "started_at": "2026-05-10T01:23:46Z",
      "eta_seconds": 35,
      "log_path": "/cell/.pi/in-flight-logs/pi-web-access.log"
    }
  ]
}
```

Possible `state` values per row:

- `pending` — install is queued but hasn't started yet (used briefly while the worker spawns; usually skipped).
- `installing` — install is running. `started_at` and `eta_seconds` populated. The agent should narrate this state when relevant.
- `failed` — install errored. `error` field added with one-line summary; full output at `log_path`. The agent should surface a graceful "I couldn't load X" reply rather than silent error.
- `done` — install completed cleanly. The row is removed within a second of `done` (no need for the agent to see successful rows; absence == done).

When all rows clear (or the only rows are `failed`), the file's `extensions` and `packages` arrays are empty. The hatch worker then deletes the file entirely. **File absence means "fully provisioned"** — no in-flight state to surface.

## How the agent reads it

A built-in pi extension `in-flight-watch` (always-on, like heartbeat-watch) checks `/cell/.pi/in-flight.json` once per turn and injects a system-message addendum if non-empty:

```
[in-flight] You are still being provisioned. Currently installing:
  - pi-web-access (~30s remaining): web search and fetch tool calls
    won't work until this lands.
  - wiki extension (~10s remaining): wiki tool unavailable.

Failed installs:
  - mentality extension: install errored 12 seconds ago, see
    /cell/.pi/in-flight-logs/mentality.log. Tool calls into mentality
    will return an error.

When the user requests something blocked by an in-flight capability:
acknowledge the limitation, offer an alternative if obvious, and
suggest retry timing. Do NOT fabricate behavior of capabilities that
aren't yet loaded.
```

The extension is conservative: it only adds the addendum when the file exists and has rows. No file = no message overhead.

## How the install worker writes it

Hatch's async tail (per `docs/eggs-spec.md`) spawns one background worker per missing capability. Each worker:

1. Reads the file under `flock` on `/cell/.pi/in-flight.json.lock`. Adds its row with `state: installing`, `started_at: now`, `eta_seconds: <best estimate>`.
2. Releases lock. Runs the actual install (`pi install <pkg>` or `cp -r <ext>` + jq edit `.pi/settings.json`).
3. On completion, re-acquires lock. Removes its row. If file is now empty, deletes the file.
4. On failure, sets state to `failed`, populates `error`, leaves the row (so the agent can surface).

ETAs come from a hard-coded table per capability (initially) — `pi-web-access ~30s`, individual extensions ~5s. Refined empirically once Phase 4 ships and we have real timings.

## Concurrency

Multiple workers writing concurrently. `flock(/cell/.pi/in-flight.json.lock, LOCK_EX)` for every R/M/W cycle. Workers hold the lock for the read+modify+write only — never during the actual install (would serialize installs that should run in parallel).

The agent's read is also under `flock`, but `LOCK_SH` (shared) — multiple turns can read concurrently, blocked only when a worker is writing.

## Failure modes

- **Worker crashes mid-install.** File row stays in `installing` state forever. Hatch supervisor (in cells.ts) registers a 5-minute timeout per worker; on timeout, sets state to `failed` with `error: install timed out`.
- **Pi crashes between turns.** Site service auto-restarts pi. Pi reads `/cell/.pi/settings.json` and `in-flight-watch` re-injects the addendum on next turn. No special handling needed.
- **File becomes corrupt** (concurrent writer killed mid-write, partial JSON). The watcher extension treats parse-fail as "no in-flight state" — degrades to silent. Worker writes are atomic via temp+rename; corrupt file shouldn't normally happen.

## Acceptance for P4.1

- [x] File path + owner specified.
- [x] Schema with state-machine values defined.
- [x] Lifecycle (when written, when deleted, file-absence semantics) specified.
- [x] Agent-side read mechanism (built-in extension, system-prompt addendum) specified.
- [x] Worker-side write mechanism (flock'd R/M/W, ETAs, error handling) specified.
- [x] Concurrency model (LOCK_EX for writers, LOCK_SH for readers) specified.

P4.1 is a paper deliverable. P4.2 implements the worker, P4.3 the failure-mode polish, P4.4 the perf measurement.

## Examples

### Hatch with one missing extension and one missing package

State at t=0 (post-hatch, talk session live):

```json
{
  "schema_version": 1,
  "hatched_at": "2026-05-10T01:23:45Z",
  "hatched_from_egg": "egg-7f3a",
  "extensions": [
    { "name": "wiki", "state": "installing",
      "started_at": "2026-05-10T01:23:48Z", "eta_seconds": 8 }
  ],
  "packages": [
    { "name": "pi-web-access", "state": "installing",
      "started_at": "2026-05-10T01:23:46Z", "eta_seconds": 32 }
  ]
}
```

State at t=10s (wiki done, pi-web-access still going):

```json
{
  "schema_version": 1,
  "hatched_at": "2026-05-10T01:23:45Z",
  "hatched_from_egg": "egg-7f3a",
  "extensions": [],
  "packages": [
    { "name": "pi-web-access", "state": "installing",
      "started_at": "2026-05-10T01:23:46Z", "eta_seconds": 22 }
  ]
}
```

State at t=35s (all done): **file deleted**.

### Hatch with one failure

```json
{
  "schema_version": 1,
  "hatched_at": "2026-05-10T01:23:45Z",
  "hatched_from_egg": "egg-7f3a",
  "extensions": [
    { "name": "mentality", "state": "failed",
      "started_at": "2026-05-10T01:23:48Z",
      "error": "npm install errored: ENOENT @mariozechner/mentality",
      "log_path": "/cell/.pi/in-flight-logs/mentality.log" }
  ],
  "packages": []
}
```

The agent's prompt addendum surfaces the failure. Subsequent turns continue to surface it (the row stays in `failed` state) until something clears it. Phase 4.3 will add a "retry install" CLI verb; until then, the user kills + rebirthers the cell.

## Pointers

- Spec: `docs/eggs-spec.md` Phase 4
- Variant matrix: `docs/eggs-variants.md`
- Filesystem layout: `docs/cell-filesystem.md`
- Built-in extension that reads this file: TBD in P4.2 implementation, will live at `proto/mother/dna/.pi/extensions/in-flight-watch/`
