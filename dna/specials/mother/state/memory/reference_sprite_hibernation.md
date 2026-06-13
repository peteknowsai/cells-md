# Well hibernation — observability + behavior

## Behavior (verified 2026-05-01)

- A **registered service** (e.g. our `agent` service that auto-starts pi)
  does **NOT** prevent hibernation. Confirmed: rick had the service
  registered, sat idle, went `cold` normally.
- An open **`cells talk <name>` session** DOES keep a cell warm. The
  `well exec` tmux attach emits keepalive traffic ~every 16 seconds
  (visible as `/v1/wells/<name>/exec` log lines), which counts as
  activity and prevents the freeze.
- Idle, unattended cells hibernate as designed.

## How to check

### Fleet status (high-level)
```
well api /v1/wells
```
Each well has:
- `status`: `cold` | `warm` | `running`
- `last_running_at`, `last_warming_at` (transition timestamps)

### Per-cell sleep/wake forensics
```
well api /v1/wells/<name>/logs
```
Returns recent host-level events as JSON. Key lines:

- `ActivityMonitor: status` — emitted every ~60s, includes:
  - `active_count` — number of things keeping it active (0 = will sleep)
  - `cgroup_frozen` — `true` means hibernated
  - `sources` — what's holding it awake, e.g. `["http:2026"]` for an
    open exec/HTTP connection on the sprite-agent port
- `request` lines — every API call (`/exec`, `/logs`, etc.) with
  timestamp + `fly_request_id`. Use these to identify external pokers.
- Lease PUTs every ~5 min — internal, ignore.

### Endpoints that DON'T exist
- `/v1/wells/<name>/events` → 404
- `/v1/wells/<name>/history` → 404

So `/logs` is the one place to read state-transition history.

## Practical use

- "Why is X warm when I expected it cold?" → grep its logs for
  `request` cadence and `sources` field.
- "When did Y last hibernate?" → look for `cgroup_frozen: true` events
  in logs.
- Closing a `cells talk` session lets a cell go cold within the normal
  idle window.
