# Eggs — operator runbook

Eggs are pre-warmed cells. The expensive part of birth (apt install, bun
install, gh, DNA push, package install) happens *once* per egg, hours in
advance. Birth-from-egg ("hatching") then takes ~5–15 seconds because
all that's left is sed-substituting identity and starting pi.

User-facing: `cells birth <name>` quietly hatches a matching egg if one
is in stock, falls back to the slow path if not. The user never types
the word "egg" or "hatch" — eggs are an implementation detail.

Operator-facing: `cells egg [...]` to manage the pool.

## Architecture in 30 seconds

- An **egg** is a sprite with the toolchain, env, secrets, proxy
  patches, and DNA on disk — but no agent identity. The DNA's
  `__NAME__` and `__THINKING__` placeholders are intact.
- An egg's **variant signature** is `model + extensions + packages` —
  the dimensions that get baked in at egg-birth and can't change.
  Stored canonically as `v1:model=opus,thinking=,extensions=memory,packages=,channels=`
  (thinking and channels are zeroed in the egg's signature).
- **Hatching** is pure determinism on the Mac: claim an egg from
  `~/.cells/eggs.json`, restore its pristine checkpoint, sed in the
  cell name + thinking level, register the chosen extensions, register
  the site service (which starts pi). Async tail (worker, slack,
  vault) converges in the background while the user is already
  talking to the cell.
- An egg matches a `cells birth` request if their pool keys match.
  `thinking` and `channels` differences don't disqualify a match.

## Operator commands

```bash
# Pre-warm an egg. Same flag set as cells birth, minus thinking/channels
# (those aren't baked).
cells egg --model=opus --extensions=memory --packages=pi-web-access

# Defaults: extensions=[], packages=[pi-web-access]. To opt out of all
# packages: --packages=
cells egg --model=sonnet --packages=

# See what's in stock
cells egg list

# Cull a specific egg by id (the 6-hex hash from `cells egg list`)
cells egg cull 7f3a2b
```

Each `cells egg ...` invocation that creates an egg takes ~3-5 minutes
(slow). After that, `cells birth <name>` against a matching variant
takes seconds.

## How auto-hatch decides

`cells birth bob` (interactive or with flags):

1. User picks (or flags supply) harness, model, thinking, extensions,
   packages, channels.
2. CLI computes the **pool key** from (model, extensions, packages).
3. CLI scans `~/.cells/eggs.json` for any egg with `state=warm` whose
   `variant_signature` equals the pool key.
4. **If found**: atomic claim, hatch. ~5–15 seconds to "alive". Drops
   into interactive talk if TTY.
5. **If not found**: fall through to the existing slow birth path.
   ~5 minutes. Same magical TTY drop-in at the end.

Either way, the user sees `cells birth bob` and ends up in
`cells talk bob`. Speed differs, behavior doesn't.

## State machine

Eggs have four states:

- **warm** — ready to hatch
- **claimed** — atomic claim in progress; transient (~10s during a hatch)
- **live** — was claimed, hatch succeeded, the egg's sprite is now a
  cell. Stays around as a breadcrumb so we know an egg got used.
- **culling** — hatch failed partway. `cells egg cull <id>` to clean up.

In Phase 1, eggs are not auto-recycled. Pete manually culls live and
culling eggs. Phase 3 (pulse-driven pool maintenance) automates this.

## Files

- `~/.cells/eggs.json` — egg registry. JSON. Hand-edit at your own risk.
- `~/.cells/.eggs.lock` — sentinel for atomic claims. Auto-cleared if
  stale (>30s).
- `~/.cells/cells.json` — gains a `status` field. Hatched cells start as
  `"warming"`, flip to `"alive"` once the async tail completes. Slow-
  birthed cells go straight to `"alive"`.

## Variant signature

Format: `v1:model=<m>,thinking=<t>,extensions=<a>|<b>,packages=<p>,channels=<c>`

- Field order is fixed: model, thinking, extensions, packages, channels.
- Multi-value fields (extensions, packages, channels) are
  pipe-separated and sorted alphabetically.
- Empty multi-values are written as `key=` (no values).
- The **pool key** is the canonical signature with `thinking=` and
  `channels=` zeroed. Two requests/eggs with the same pool key are
  hatch-interchangeable.

Library: `cli/lib/variant-signature.ts` (pure, unit-tested).

## Skills + prompts

- `proto/mother/.pi/skills/birth-egg/SKILL.md` — the egg-birth ritual.
  Forked from `birth/SKILL.md` minus per-cell steps (4b, 4c, 7, 11, 12).
- `proto/mother/.pi/prompts/egg-birth.md` — prompt mother receives.
  Takes a sprite name and a JSON config (no name, no thinking, no
  channels — those are hatch-time).
- **No `cull-egg` skill.** Eggs have no side effects beyond their
  sprite, so cull is direct `sprite destroy --force` from the CLI.
  No mother in the loop.

## What this doesn't do (Phase 1)

- **Closest-match-and-tweak.** If you ask for a variant that has no
  exact-match egg, we fall back to slow birth. Phase 2 will
  hatch-the-nearest-egg-and-tweak.
- **Pulse-driven maintenance.** The pool doesn't refill itself. You
  manually `cells egg ...` to keep stock.
- **Aged egg rotation.** Eggs have a `max_age_at` (born_at + 7 days)
  but it's not enforced. Phase 3.

## End-to-end test

```bash
cells egg --model=opus --extensions=memory --packages=
cells egg list   # confirm warm
time cells birth testcell --model=opus --thinking=high --extensions=memory --packages= --channels=
# expect: <20s to alive, drops into talk
# (chat with it, then exit)
cells kill testcell --yes
cells egg list   # the egg moved to state=live; cull manually
cells egg cull <id>
```
