# Naming — vocabulary for the whole system

The cells stack uses biological vocabulary at every layer because the metaphor actually works: there's a real correspondence between how cells (the organism) live in containers, group into teams, and aggregate into populations, and how the software equivalents do the same. This doc locks the vocabulary so it stops drifting in commit messages, code comments, and onboarding docs.

**Status:** locked 2026-05-07.

## The vocabulary

| Layer | Name | What it is |
|---|---|---|
| atomic unit *(alive)* | **Cell** | a Pi agent / running env — the user-facing thing |
| team *(alive)* | **Pod** | a tight cohesive group of cells working on related problems |
| org *(alive)* | **Colony** | many pods rolled up — a company / multi-team aggregation |
| runtime *(built)* | **Well** | the VM that runs exactly one cell |
| host *(built)* | **Lab** | the machine that holds many wells (Mac Mini, VPS, managed cloud) |

Two families, sharply separated:

- **Family A — alive**: `Cell → Pod → Colony`. Living, organic, scales from one organism up to a population. Names are biological at every step.
- **Family B — built**: `Well + Lab`. Deterministic structures that the live things sit in. Lab equipment, not creatures.

**In plain English:** cells are the things that *are alive*. Wells and labs are the things they *live in*. You'd say "I'm working on a cell" but you wouldn't say "I'm working on a well" — you'd say "I'm spinning up a well to put a new cell in." The name signals which side of the metaphor it sits on.

## Cell lifecycle states

Cells have three states. The vocabulary mirrors a biological gradient — body temperature warm down to cryopreserved.

| State | What it means | Cost | Wake from |
|---|---|---|---|
| **Alive** | the cell is in RAM and responsive | full RAM (e.g. 4GB) per cell | already up; ~100ms if currently CPU-paused |
| **Hibernating** | RAM written to disk, memory freed, sleeping | ~9GB local disk (5GB filesystem + 4GB RAM image) | ~1–3s |
| **Frozen** *(future)* | hibernation file offloaded to remote storage (e.g. R2), local copy gone | ~5GB local disk (filesystem only); RAM image lives in cloud | ~30s+ (download + restore) |

**Alive vs. running vs. paused.** Inside the *Alive* state, the VM might be running (CPU active) or paused (CPU idle, memory still mapped). That's an implementation detail the watchdog uses to free CPU on idle alive cells. From a user perspective there's no difference — both are responsive within sub-second.

**Why no "cold" tier.** Earlier designs had a cold tier (= stopped, only the disk image remains, no preserved agent state). Dropped because:
- On owned hardware, the disk savings of cold over hibernating (~4GB per cell) are irrelevant — terabytes are cheap.
- Cold throws away the agent's working memory. For pi cells, that means losing model context, conversation state, in-flight reasoning. Almost never the right call.
- "I want this cell *truly* gone" is `splite destroy` (with a checkpoint to resurrect later), not a tier.

If you ever need to force-restart a hibernating cell from scratch (kernel update, recovering a wedged process), that's a flag on wake (`--fresh` discards the hibernation image and boots from disk), not a separate tier.

**The Frozen tier (future).** Hibernating cells live on local disk. For long-tail cells you don't need on this machine — months idle, archived state, or migration targets — there's a future tier where the hibernation image gets uploaded to remote storage (R2 or S3-compatible) and the local copy is deleted. Bringing it back is a thaw: download, then restore-from-hibernation. The R2 sync infrastructure landed in Phase A.2 of the splites repo; the watchdog hook to actually move cells frozen-ward hasn't been wired yet.

**Lifecycle picture:**

```
   create
     │
     ▼
  ┌──────────┐  watchdog idle    ┌─────────────────┐  long-idle (future)  ┌──────────┐
  │  Alive   │ ─────────────────▶│  Hibernating    │ ─────────────────────▶│  Frozen  │
  │ (in RAM) │ ◀───────────────  │ (on local disk) │ ◀──────────────────── │ (in R2)  │
  └──────────┘   wake             └─────────────────┘     thaw              └──────────┘
       │                                  │
       │                                  │  destroy
       │                                  ▼
       │                            ┌──────────────┐
       │                            │  Destroyed   │
       └───────────────────────────▶│  (gone, but  │
                                    │  checkpoint  │
                                    │  resurrects) │
                                    └──────────────┘
```

**In plain English:** A cell is one of three things: awake and answering you, taking a nap on disk, or shipped off to long-term cold storage in the cloud. There's no fourth "totally off" state because keeping a cell hibernating costs almost nothing and keeps everything it remembers. The only way a cell really goes away is if you destroy it on purpose — and even then, a checkpoint can bring it back.

## Family A — life forms

### Cell

A cell is the atomic unit. One Pi agent, one identity, one bag of state. It maps roughly 1:1 with a process the user thinks of and talks to. When you say "talk to pete," pete is a cell.

This name was already locked before any of the others — it's the project name. Everything else was chosen to fit around it.

### Pod

A pod is a team-sized group of cells working on related things. Spotify-squad scale: small, cohesive, with shared identity. "The Search Pod" reads natural in a sentence and doesn't trip on existing software jargon the way "stack" or "cluster" would.

The biology check: pods are real (whales travel in pods, peas come in pods), so the name doesn't break the alive-things family. It also already means "small tight team" in everyday English, which is rare for biological terms — most people don't have to learn a new word.

Other candidates considered and rejected:
- **Culture** — biologically perfect ("cell culture") but too important a word to recycle. "Team culture" already means something specific to humans; muddying it with a tech tier creates needless ambiguity.
- **Lab** — was a strong contender for the team tier, but a lab is a *facility*, not a biological aggregation of cells. It sits more naturally in Family B (the built side), and that's where it landed.
- **Brood** — has the right "born together, work together" energy but reads slightly weird in everyday sentences.
- **Strain** — most biologically accurate (bacterial strains are real), but "strain" has negative everyday connotation (eye strain, mental strain).

### Colony

A colony is the org-level aggregation. Many pods roll up into one colony — a company, a department, a multi-team org. Microbiology colonies are clusters of cells (technically clonal, but the colloquial sense of "many cells living together" is the one that matters here).

This is forward-looking. The cells stack today is single-org and doesn't surface a colony-level concept; the name is locked so when multi-org tooling lands it has a place.

## Family B — built things

### Well

A well is the deterministic structure that holds exactly one cell. In real microbiology, a well is the slot on a multi-well plate where you drop one specimen — the term is precise about the one-to-one shape. That's our shape: one VM, one cell, one well.

Things to know about wells:
- A well is what splites used to be called. The new name corrects two things: "splites" was a portmanteau (split-from-wells) that doesn't carry on its own, and the old name implied many-cells-per-thing when in practice we run one cell per VM.
- The runtime is *built*, not alive. It boots, it stops, it gets cloned, but it doesn't grow or morph the way a cell does. The name reflects that — "well" is hardware, "cell" is the resident.
- Wells are stackable / interchangeable / clonable. The cell inside is the precious bit. Wells get spun up and torn down freely.

Other candidates considered and rejected for this tier:
- **Husk** — biological structural ("outer protective layer") but reads slightly negative (an "empty husk").
- **Vial** — lab-real but small/single-use connotation.
- **Slide** — microscope slide, but slides are display surfaces, not housing.
- **Bay** / **Slot** — generic; less metaphorically grounded.
- **Dish** — was the early lock, but a dish in real microbiology holds *many* cells, not one. Dropping it for accuracy.
- **Stack** — too overloaded with software meaning ("my stack").

### Lab

A lab is the host machine. The thing wells sit on. In academic biology, "the Smith Lab" is the team's physical space — full of dishes, wells, plates, equipment. We're using the *physical* meaning here, not the team meaning.

A lab can be:
- Pete's Mac Mini sitting on his desk (a personal lab)
- A rented VPS at Hetzner (a cloud lab)
- A future managed-Lab service we ship to other people (lab-as-a-service)

The name is host-agnostic. A well doesn't care whether its lab is a Mac in a closet, a Hetzner box, or someone's cloud. A lab is a deployment target; "where you put your wells."

**In plain English:** if a cell is a person and a well is the apartment they live in, the lab is the building. People don't care which building; the building's job is to keep their apartment intact and connected to the network.

## Sample sentences

These are the test for whether vocabulary actually works. If you can't say it out loud, the name is wrong.

> "I'm spinning up a new well in my lab to host the pete cell."

> "Search Pod is shipping a feature this week — three cells working on it."

> "Pete's lab has 5 wells. Each well runs one cell. The cells belong to the Search Pod, part of the Anthropic Colony."

> "Move that well to a different lab — your Mac is full."

> "How many cells in our colony right now?"

> "Stop the well; the cell will be paused and resume when the well wakes back up."

These all read clean. Earlier attempts (with "splites," "dish + stack," "culture + colony") tripped over double meanings or scaled awkwardly.

## Naming for code, files, bundles

- **Project name** for the runtime/engine layer: **Well** (formerly "splites"). Repo name and CLI binary name follow.
- **Apple bundle ID** for the signed Mac engine binary: **`md.cells.well.engine`**. The `.engine` suffix names the *role* (the engine that runs wells), not the *implementation* (today: a patched fork of [lume](https://github.com/trycua/lume); tomorrow possibly Firecracker on Linux). This survives engine swaps without stranding the bundle ID.
- **Future signed binaries** under the Well namespace can use `md.cells.well.<role>` (e.g. `md.cells.well.cli`, `md.cells.well.daemon`). The bare `md.cells.well` namespace stays open for any top-level component.

**What we deliberately did NOT put in the bundle ID:**
- "lume" — that's an implementation detail of the current Mac engine. Bundle IDs are forever; lume might not be. Phase E (Linux hosting) plans to swap to Firecracker/QEMU, and a `md.cells.well.lume` bundle would be permanently confused.
- "splites" — old project name for the well runtime, kept around in old docs and commits but not in any new identifier.

## What this replaces / clarifies

If you read older docs in this repo, in the `splites` repo, or in scratchpad commits, you may see these earlier names — they all map cleanly to the locked vocabulary:

| Old term | New term | Notes |
|---|---|---|
| splite / splites | well / Well | A "splite" was always a single-cell VM. "Well" is more precise. |
| well / wells | (no rename) | "Wells" is Fly.io's product, an external dependency. We don't rename someone else's product. |
| Mac mini host | lab | "Lab" is the new word for any deployment target, including the Mac Mini. |
| host machine / VPS / cloud target | lab | All deployment targets are labs. |
| cell pool | (was already pool, may become "pod" if refactored) | The internal data structure for "cells managed together" hasn't been renamed yet; doing so is a future cleanup. |
| team / squad | pod | Use "pod" everywhere we previously said "team" or "squad" in a domain context. (Don't replace "team" when it means "humans on a project" — that's organizational, not domain.) |
| org | colony | Use "colony" when referring to the multi-pod aggregation as a system-level concept. |

## What's shipped vs. forward-looking

| Term | Status |
|---|---|
| Cell | shipped — `cells` repo |
| Well | naming locked; engine work in progress in the `splites` repo (rename pending) |
| Lab | naming locked; just a deployment target — nothing to ship beyond per-host config |
| Pod | naming locked; no code yet — needed once multi-team coordination ships |
| Colony | naming locked; no code yet — needed once multi-pod / org tooling ships |

Treat the unlocked code as "the implementation will catch up to the vocabulary." When you add code that touches a layer, use the locked name from day one — don't introduce another temporary term that has to be migrated later.

## Why these constraints

A few rules drove the final picks. Useful for evaluating any future name:

1. **Two families, separated.** Living things have living-thing names; built things have built-thing names. Mixing them across layers (a "lab" of cells, a "culture" of equipment) breaks the metaphor and makes the system harder to reason about.
2. **Each name a real word.** No portmanteaus (splites), no eponym fragments (a "petri" by itself isn't a noun). Real words come pre-loaded with meaning; portmanteaus charge a tax every time someone reads them.
3. **Short and punchy.** Three to six letters, one or two syllables. Names get typed, said in standups, written in commit messages — short wins.
4. **Low collision with software jargon.** "Stack" was rejected because "my stack" overwhelmingly reads as "my tech stack." "Pod" survived the same test because biology is its primary meaning even in tech-saturated rooms.
5. **The metaphor has to scale.** `Cell → Pod → Colony` works because each tier is a real biological aggregation of the previous. "Lab" doesn't scale that way, which is why it sits in Family B instead.

If you're naming something new in the cells stack, run it through these. If it fails any of them, keep looking.
