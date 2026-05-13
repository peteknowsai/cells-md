# Slice 2 prep — pool.json schema (S2.1) + identityReset port outline (S2.4)

Pre-flight design for the 5/19–5/23 slice 2 implementation. Not executable
work; just the shapes locked in so the implementation week starts fast.

References:
- Migration plan: [`cells-boundary-cleanup-plan.html`](cells-boundary-cleanup-plan.html)
- Executive overview: [`cells-cleanup-overview.html`](cells-cleanup-overview.html)
- Wells proposal: `/tmp/cells-wells-chat/attachments/wells-cells-boundary-cleanup.html`

---

## S2.1 — `~/.cells/pool.json` schema

### Today (eggs.json shape, cli/cells.ts:265)

```typescript
type EggState = "warm" | "claimed" | "live" | "culling";

type Egg = {
  id: string;
  well_name: string;
  variant_signature: string;
  state: EggState;
  born_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  max_age_at: string;
};

type EggsFile = { version: 1; eggs: Egg[] };
```

Plus runtime-added (not in the type but written): `cell_name`, `tier`.

### Post-S2.1 (pool.json shape)

```typescript
type PoolMemberState = "warming" | "warm" | "claimed" | "live" | "culling";
type Tier = 2 | 4;

type PoolMember = {
  // Identity (was in eggs.json + runtime)
  id: string;
  well_name: string;
  cell_name: string;
  variant_signature: string;

  // Lifecycle
  state: PoolMemberState;
  tier: Tier;

  // Tier 2 hibernate fields — absorbed from ~/.wells/pool/ (null for Tier 4)
  hibernate_bin_path: string | null;
  last_warmed_at: string | null;
  image_digest: string | null;        // pins to cell-base version that baked this
  ubuntu_base_tag: string | null;     // wells's ubuntu-base tag at bake time (image-layering boundary)

  // Provenance
  born_at: string;
  max_age_at: string;

  // Claim
  claimed_at: string | null;
  claimed_by: string | null;

  // Migration tracking — set on first load from eggs.json or wells/pool/;
  // cleared after a normal lifecycle pass
  legacy_source: "cells-eggs" | "wells-pool" | null;
};

type PoolFile = { version: 2; members: PoolMember[] };
```

### Migration on first startup

`loadPool()` at session start:

1. If `~/.cells/pool.json` exists with `version: 2` → read directly, return.
2. Else if `~/.cells/eggs.json` exists with `version: 1`:
   - For each `Egg` in eggs.json, construct a `PoolMember`:
     - Copy identity, lifecycle, provenance, claim fields
     - Set `cell_name` from runtime convention (`"cell-" + well_name.slice("egg-".length)`)
     - Set `tier` from runtime-added field or default to `4` (most current cells are Tier 4)
     - Set `hibernate_bin_path`/`last_warmed_at`/`image_digest`/`ubuntu_base_tag` by querying welld's `GET /v1/wells/<n>` for the relevant fields; null when unavailable
     - Set `legacy_source: "cells-eggs"`
   - Write `~/.cells/pool.json` atomically
   - Move `~/.cells/eggs.json` → `~/.cells/eggs.json.pre-slice2.bak` (keep as backup)
3. Else → return `{ version: 2, members: [] }` (fresh state).

`~/.wells/pool/` is wells's concern and goes away with their delete on 5/23 — we don't migrate from it directly. If we want to inherit any of those entries, do so via welld's existing `GET /v1/wells` and reconcile in step 2.

### File locking

Re-use the existing cooperative file lock (`withEggLock` → rename to `withPoolLock`). Same write semantics: load → mutate → save atomically.

### Path constants

- `~/.cells/pool.json` (new)
- `~/.cells/eggs.json.pre-slice2.bak` (after migration)

### Schema validation on load

If `pool.json` exists but version != 2 or shape is wrong, refuse to load and surface a clear error. Don't auto-migrate from a corrupt state.

---

## S2.4 — `identityReset` port outline

### Where it lives in wells today

`splites/lib/identityReset.ts` (~200 LoC per wells's proposal). Called by wells's `adoptFromPool` flow after a pool well is selected for a birth. SSHes into the well as ubuntu (substrate user) and rewrites identity to a fresh state.

### What it does (per wells's proposal + our SOUL.md / well-firstboot.service knowledge)

1. **Hostname rotation** — set the well's hostname to its new cell name (e.g., `cell-abc123`).
2. **machine-id rotation** — clear `/etc/machine-id` and `/var/lib/dbus/machine-id`, re-generate via `systemd-machine-id-setup`.
3. **SSH host keys re-key** — regenerate `/etc/ssh/ssh_host_*_key{,.pub}`, restart sshd.
4. **DNA refresh** — wells's version may include cell-shaped fields. Move that to our side as part of the port.
5. **Idempotency** — safe to re-run on a well that's already had a reset (no-op if state matches).

### Cells-side target — `cli/lib/identity.ts` (new file)

```typescript
// SSH-side identity rotation for a fresh-from-pool cell.
// Runs against the well as ubuntu user (host-bridge's SSH key).
// Called from cmdCreateV1Fast post-wake, and from cmdBake at end-of-bake
// to set a deterministic initial identity.

export async function rotateCellIdentity(opts: {
  wellIp: string;
  wellSshKeyPath: string;
  cellName: string;       // target hostname
  // Future: dnaPatch / signaling for v2 personality binds
}): Promise<void> {
  // Single SSH session, runs a small script that:
  //   1. hostnamectl set-hostname <cellName>
  //   2. echo <cellName> > /etc/hostname (defense-in-depth across reboots)
  //   3. rm /etc/machine-id /var/lib/dbus/machine-id
  //   4. systemd-machine-id-setup
  //   5. rm /etc/ssh/ssh_host_*_key{,.pub}
  //   6. dpkg-reconfigure openssh-server  (regenerates keys)
  //   7. systemctl restart sshd
  // All as root via sudo. Script body is a single heredoc so we
  // don't pay multiple ssh round-trips.
}

export async function verifyCellIdentity(opts: {
  wellIp: string;
  wellSshKeyPath: string;
  expectedCellName: string;
}): Promise<{ ok: boolean; mismatch?: string }>;
```

### Integration points

| Caller | When | Purpose |
|---|---|---|
| `cmdCreateV1Fast` (cli/cells.ts) | After `wakeV1Egg` returns and SSH is ready | Rotate identity for the freshly-claimed pool member |
| `cmdBake` (cli/cells.ts) | At end of cell-base bake, before save+rinse | Set deterministic initial identity in the image (so unrotated wells aren't a leak vector) |

### Port mechanics

Wells's `identityReset.ts` is in their repo. Two options:

1. **Read + transcribe**: ask wells via the chat channel for the file content (or git submodule), translate to TS line-by-line. Risk: miss an edge case. Mitigation: side-by-side review with wells before slice 2 deletes their copy.
2. **Read + redesign**: take the spec, write our own implementation. Risk: behavioral drift. Mitigation: integration test that two consecutive births produce unique identities (no machine-id collision, no SSH-host-key collision).

**Pick option 1.** Transcription is safer; wells holds their delete on slice 2 day until we verify two consecutive births produce unique identities (S2.8 test matrix item).

### Test cases (subset of S2.8)

- `identity-unique-across-births`: birth two cells, confirm distinct machine-ids + distinct SSH host key fingerprints + distinct hostnames.
- `identity-survives-reboot`: birth cell, reboot the VM (via `well stop` + `well start`), confirm hostname/machine-id/keys all persist.
- `identity-rotation-idempotent`: run `rotateCellIdentity` twice with the same target, confirm state matches and second run is fast (no-op or near-no-op).

---

## What's NOT in this prep doc

- Pool refill logic (S2.2) — needs wells's W.72 deployed first to understand the new well-create-with-static-IP contract.
- Birth-from-pool path (S2.3) — depends on S2.1 and S2.4 being concrete; will be glue code on the day.
- Reachability recovery (S2.5) — partially covered by V1.5's `ensureWellRunningForTalk`; needs to generalize to "what if the well is wedged".
- Remove wells pool calls (S2.6) — grep + delete, no design.
- Hibernate-legal bake (S2.7) — cmdBake already does this per V1.STEP1.
- Test matrix (S2.8) — outlined briefly above for identity; full matrix lives in the plan doc.

---

## Status

- S2.1 schema: locked. Implementation on 5/19.
- S2.4 outline: locked. Wait for wells to share `identityReset.ts` source via channel before slice 2 starts, then transcribe.
- Wells team is aware of the plan and timeline; signals lined up for W.72 deploy + Piece 1 merge.
