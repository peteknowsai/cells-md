# Wells — the substrate cells live in

A **well** is the VM that runs exactly one cell. Wells live on a **lab** (a Mac Mini today, a VPS or managed cloud later). The wells layer is the substrate; cells is the organism inside. See [`naming.md`](naming.md) for the locked vocabulary.

This doc collects everything cells code needs to know about wells: the API surface, the agent user, fast-fork via images, and operating signals. The wells repo is the source of truth (`~/Projects/wells`); when in doubt, that's where to look.

## Where wells live

- **Daemon**: `welld` on `127.0.0.1:7878`. Starts via launchd (`md.cells.welld`) on login; logs at `~/.wells/welld.log`. Restart with `launchctl kickstart -k gui/$(id -u)/md.cells.welld`.
- **CLI**: `well` — thin client over the daemon's REST. Mother's pi extension `well-tools` wraps a curated subset.
- **State**: `~/.wells/` (token, registry, per-VM bundles, saved images). Daemon-owned; never edit by hand.
- **Auth**: `Authorization: Bearer $WELL_TOKEN`. Token at `~/.wells/token` (mode 0600). The CLI reads it; cells code should hit the daemon through the CLI or read the token from disk.

The wells team also exposes everything under `/v1/sprites/...` as an alias — cells code that pre-dates the rename keeps working unchanged.

## The agent user inside a well

Every well boots with the substrate user, and `cells bake` adds a tenant user on top:

- **`well`** (uid 1001, NOPASSWD sudo). The substrate user. `/home/well/.ssh/authorized_keys` is populated with the operator's host key on first boot. `well exec`, `well console`, and the daemon's `/v1/wells/{n}/exec` HTTP/WS endpoints all default to `well@<ip>`. Use this user for substrate-level ops (bake, install, sudo bookkeeping).
- **`cell`** (uid 1002, sudo group). The tenant user. Created by `cells bake`'s `bakeCreateCellUser`; HOME is `/cell` (not `/home/cell`). Pi runs as `cell`, the agent's DNA + memory + site + node_modules all live under `/cell/`. SSH'ing into a cell with `cells shell <name>` targets the `cell` user. `well exec ... -- sudo -u cell bash -c '...'` is the canonical way to run as cell from the substrate side; `wellExecCapture(name, script, {user: "cell"})` and the mother's `well_exec` tool both default to user=cell.
- **`ubuntu`** — cloud-image default, kept for raw-VM debug. Override with `well exec --user ubuntu …` on the CLI or `{"user":"ubuntu"}` in an HTTP exec body.

Paths in remote command bodies should be absolute (`/cell/...` for tenant content, `/home/well/...` only for substrate bookkeeping). Tilde expansion depends on which user runs the shell — prefer explicit paths.

## API surface (sprites-shaped, sprite-compatible)

Everything is `Authorization: Bearer $WELL_TOKEN` unless noted.

### Lifecycle

- `POST /v1/wells` body `{name, cpu?, memory?, disk?, env?, r2?, from_image?}` → `WellResource` (201). Creates a new well. `--env KEY=VAL` (repeatable, CLI) lands pairs in `/etc/environment` via cloud-init — visible to every SSH session including non-login. Use for `CELLS_PROXY_SECRET` so the secret is present from boot.
- `POST /v1/wells/{n}/start` and `/stop` — idempotent. Start unpauses paused wells too.
- `GET /v1/wells/{n}` → `WellResource` (`name`, `status`, `url`, `ip`, `cpu`, `memory`, `disk_size`, ...).
- `DELETE /v1/wells/{n}` → idempotent destroy.

### Exec — wakes the well first

`POST /v1/wells/{n}/exec` body `{command: string[], user?: string}` → `{exit_code, stdout, stderr, truncated?}`. Synchronous, 4 MB combined cap. If the well is stopped or paused, welld starts it before SSHing — caller pays ~5s on first exec after a stop. `user` defaults to `well`; set to `"ubuntu"` for raw-VM access.

WebSocket on the same path streams output for long-running commands. First frame must be `{type:"start", cmd:[…], tty?:bool, user?:string}`.

### Per-well config

- `GET/POST /v1/wells/{n}/policy/network` — domain allow/deny rules, persisted.
- `PUT /v1/wells/{n}/url` body `{auth: "public"|"well"}` — flip per-well proxy auth.
- `PUT/DELETE /v1/wells/{n}/services/{id}` — register/deregister site services.

### Checkpoints

`POST /v1/wells/{n}/checkpoints` body `{comment?, retain_for?}` — APFS clonefile of the well's disk. Checkpoint create requires the well running (welld wakes it on demand). Restore via `POST /v1/wells/{n}/checkpoints/{id}/restore`. Cold-tier sync to R2 if `--r2-*` was passed at create.

## Fast forks — the image store

When cells's birth flow wants to fork many cells from a known-good baseline (agent code pre-installed, dependencies baked, etc.), saved images skip the slow cloud-init bake. APFS clonefile means a 5GB image clones in **sub-millisecond regardless of size**. This is the speedup that makes mass cell creation cheap.

### Workflow

```sh
well image save <well> <image-name>           # snapshot a stopped well's disk
well image list [--json]                       # what's saved
well image info <image-name>                   # disk size, source, created_at, notes
well image rm <image-name>
well create <new-name> --from-image <image-name>
```

REST (sprites-aliased too):

- `GET /v1/wells/images` → `{images: [...]}`. Each entry: `{name, from_well, from_disk_size, created_at, notes?, size_bytes?}`.
- `POST /v1/wells/images` body `{name, from_well, notes?}` → `ImageResource` (201). Source must be **stopped** — clonefile of a hot disk gets a torn snapshot (returns 409 `well_running` if it's up).
- `GET /v1/wells/images/{name}` → `ImageResource`.
- `DELETE /v1/wells/images/{name}` → `{name, removed}`.
- `POST /v1/wells` body extends to `{… from_image: "<image-name>"}` — clones from that image instead of the default `ubuntu-25.10-base`.

`ubuntu-25.10-base` is the prebuilt baseline shipped with wells. It's the canonical example of a cleanly-forkable image (no source-well identity baked in).

### Save semantics — no rinse needed

A saved image inherits the source well's identity (hostname, machine-id, ssh host keys), and that's fine. When you fork via `well create <new> --from-image=<saved>`, welld attaches a fresh cidata with a new instance-id. cloud-init detects the new instance-id, re-runs its `runcmd`, and resets identity automatically:

- `/etc/machine-id` regenerated
- ssh host keys regenerated (cloud-init's `ssh_deletekeys: true` + `ssh_genkeytypes`)
- `/etc/hostname` set from cidata's `local-hostname`
- well user provisioned (idempotent — runcmd guards against duplicates)

So `well image save <source> <name>` (source stopped) is sufficient. No flags, no in-VM scrub script. Welld briefly had a `--clean` flag that did a welld-side SSH rinse; it broke forks by stripping state cloud-init's re-run depends on. It's gone — just save plain.

## Operating signals — health + degraded mode

Two read-only surfaces for cells's automation to detect "wells is in a bad place" without poking individual wells:

### `GET /healthz` (no auth)

```json
{
  "ok": true,
  "version": "0.1.0-pre",
  "started_at": "2026-05-08T...",
  "lume": {
    "base_url": "http://127.0.0.1:7777",
    "owned": true,
    "respawns_last_hour": 0,
    "respawns_last_5min": 0,
    "respawns_last_1min": 0
  },
  "degraded": false
}
```

`degraded: true` flips on when welld's lume supervisor has respawned lume serve 5+ times in the last 5 minutes. At that rate, lume is bouncing under load and user-facing operations are fragile. **Cells's birth flow should poll `/healthz` and back off when `degraded` is true** rather than retrying into a flapping system.

### `well doctor` CLI

```sh
$ well doctor
=== welld ===
  version:      0.1.0-pre
  uptime:       12m
  degraded:     no
  lume owned:   yes (welld supervises)
  lume respawns 1m/5m/1h: 0/0/0
=== lume serve ===
  status:   healthy
  VMs:      0 / 2 max
=== orphaned lume run subprocesses ===
  (none)
=== wells ===
  pete            stopped    192.168.64.7
  ...
RESULT: wells is HEALTHY
```

Read-only one-shot diagnostic, safe to run during a live birth flow. Exit codes: `0` healthy, `1` unhealthy, `2` degraded. Use in automation: `well doctor || handle_failure`. Pass `--json` for the structured `DoctorReport`.

## What's NOT a wells concern

- Picking the operator's domain. That's set in `WELL_PUBLIC_BASE` at install time.
- Worker code or its routing logic. Cells team owns that.
- DNS or cloudflared config. Operator owns that.

## Where things break and what to look at

- **`502 well '<name>' not found or not running`**: hit welld but the well isn't registered or has no DHCP lease. `well list`, `well info <name>`.
- **`502 bad gateway: Unable to connect`**: well is running but nothing listens on guest:8080. Register a site service.
- **Bare-host requests get 401**: that's correct. The API path requires bearer; only proxy traffic skips auth.
- **First exec after stop is slow**: that's the wake-on-demand cycle (~5s). Subsequent execs are instant.
- **Welld unresponsive**: `launchctl list | grep welld` should show `md.cells.welld`. Logs at `~/.wells/welld.log`. Restart: `launchctl kickstart -k gui/$(id -u)/md.cells.welld`.

## Pointers into the wells repo

- `docs/architecture.md` — full state-on-disk layout
- `docs/install.md` — host-level setup (cloudflared, ACM, launchd)
- `docs/cells-integration.md` — the contract this doc summarizes from cells's side
- `docs/MVP-PLAN.md` — what's shipped, what's next
