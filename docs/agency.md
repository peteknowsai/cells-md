# Agency — the cells stack as cooperatively self-managing intelligence

A great-idea doc, not a spec. Captures a thesis we're building toward: that the right architecture for a fleet of agents is one where each agent has direct control over its own lifecycle — knows when it's working, when it's done, when it should sleep, when it should wake up — and the substrate around it provides only the levers to act on those decisions.

This is a deliberate inversion of the usual orchestration model. Worth writing down because it's load-bearing for a lot of design decisions we've made and ones we'll keep making.

## The thesis

**The agent has perfect knowledge of its own state. Nothing observing from outside can match it.** A watchdog can guess "is this cell idle?" from network traffic patterns and CPU stats. The agent itself *knows* — it just finished a turn, or it's mid-LLM-call, or it's waiting for a webhook, or it's done for the day. There's no heuristic that improves on first-person knowledge.

**The system is more efficient when it lets agents drive their own scheduling.** A 60-second outside-in idle threshold is a safety blanket compensating for blindness. A two-second cooperative pause-on-idle is what's possible when the agent itself signals when it's done. That difference compounds across hundreds of cells — the difference between 10 agents fitting on a host vs. 100.

**Wake is a consequence of traffic, not a primitive.** When something needs an agent — a scheduled time, a webhook firing, another agent's decision, a user typing — that something just sends traffic. The substrate auto-resumes the cell. The agent doesn't need a separate "wake-at" API; it just needs *anything* to reach it, and reaching it is something every layer of the stack is good at.

**The agent can decide who or what wakes it.** It can write to a heartbeat file ("wake me at 2pm"). It can subscribe to a webhook ("wake me when this PR merges"). It can ask another agent to review a condition before deciding to wake it ("wake me only if there's a real customer issue, not just spam"). The vocabulary is unbounded because the wake mechanism — traffic — is universal.

**The whole stack composes from this.** Cells are the unit. Pulse is the scheduler that reads agents' wake intentions. Splited is the mechanism that pauses and resumes. Pi is the harness that knows when the agent is working. None of these layers needs to be smart about the others' job. They each expose primitives, and the agent — with its perfect self-knowledge — composes them.

## Why this matters

### Efficiency

A naive system runs every agent it might need, all the time. Cost: linear in agent count.

A scheduled system runs agents on a cron. Cost: proportional to scheduled time × agent count, plus the cost of agents that should run but don't because the schedule didn't anticipate.

A self-managing system runs only what's actively working. Cost: proportional to actual work performed. Inactive agents cost only their footprint (memory if hot, disk if hibernating, R2 storage if frozen). The system's resource use tracks the *useful* work being done, not the *potential* work.

On Pete's 48GB M5 Pro, the difference is concrete. ~8 cells fit alive at once. Naive scheduling means 8 agents are all the system can host. Self-managing means hundreds of cells live on disk, with whichever 8 are actively working occupying RAM. The host doesn't even notice the rest exist.

### Scale

Outside-in monitoring scales as O(N) — the orchestrator must watch every agent. Self-managing scales as O(1) on the orchestrator: each agent is responsible for its own state. The orchestrator only intervenes when the social contract breaks (a wedged agent that won't say it's done, a runaway agent that won't pause).

A fleet of 1,000 self-managing agents is not 100× harder to operate than a fleet of 10. It's roughly the same operator overhead per agent.

### Alignment

The cooperation model has natural alignment properties. Agents are responsible for their own resource use:

- A well-behaved agent that signals working/idle correctly gets aggressively packed — minimal overhead, fast wake, full state preservation.
- A misbehaved agent (one that pretends to be busy forever) gets noticed and intervened on — but it can't *infinitely* consume resources because the host has finite memory.
- The reward gradient points the right direction: cooperation is cheaper than non-cooperation.

Bad agents are visible. Good agents are invisible (efficient, fast, low overhead). That's the right shape.

### Composability

Because every wake is just "send traffic to the cell," any agent that can send traffic can wake any other agent. This includes:

- A scheduler agent (pulse) waking agents on time-based triggers
- A reviewer agent waking agents based on subjective judgment ("is this incoming request worth waking pete for?")
- An agent waking another agent because it needs help ("hey philosopher, what do you think about this?")
- An external system (a webhook, an alarm, an event bus) waking an agent through a thin proxy

Self-managing agency means agency-over-other-agents is a natural consequence. The same primitive that lets an agent pause itself lets *another agent* decide whether it should be woken.

## Concrete instantiations in our stack

What we've actually built that gestures at this thesis:

**Splited's cooperation API** (splites repo, `docs/cooperation.md`).
- Two verbs: `/working` and `/sleep`
- Cells inside a VM signal their own state; splited believes them
- Wake is automatic on inbound traffic — no wake-at primitive needed

**Pi's lifecycle hooks** (pi.dev).
- `agent_start`, `agent_end`, `tool_call`, `tool_result`
- The harness already exposes the agent's state machine; we just thread it to splited
- 5 lines of extension code = full participation in the cooperation contract

**Pulse** (`docs/pulse.md`).
- Reads each cell's `HEARTBEAT.md` — the cell's declaration of when/why it wants to wake
- Schedules wake-ups, fires them via `cells talk`
- Subjective wake fits naturally: pulse can run a sub-agent to evaluate conditions before deciding to fire
- Agents talking to agents about agents is the system's natural mode

**The lifecycle model** (splites repo, `docs/lifecycle.md`).
- Alive / Hibernating / Frozen — three states, all of which preserve agent memory
- No "Cold" tier (= stopped, agent state lost) by default — losing memory should be exceptional, not normal
- Self-managing agents protect their own continuity; the substrate respects it

**Naming** (`docs/naming.md`).
- Cell → Pod → Colony for living things
- Cells have first-class identity. They're not workloads to be evicted; they're organisms with continuity.
- The vocabulary itself encodes the thesis.

## Local-first, and the memory floor

The whole architecture is designed to run on hardware you own. Cloud is auxiliary — useful for specific surfaces (R2-backed Frozen tier for long-tail archive, a CF Worker as the edge proxy for `<cell>.cells.md` URLs, maybe a watcher daemon eventually) but never the primary substrate. The reason isn't ideological; it's that the thesis only works on owned hardware.

### Why local

Cooperative pause-on-idle is only economical when *idle cells cost nothing*. On metered cloud (Fly, AWS, anywhere with per-second billing on RAM and storage), keeping a thousand cells durable-but-paused has a price. On a Mac Mini in a closet, it doesn't — the hardware is paid up, electricity is the only marginal cost, and disk is functionally free at human scale. The same pause-resume mechanism that's a cost-saver locally is a wash or worse in the cloud, because cloud pricing assumes you'd just *stop* what you're not using.

So the design that works locally — hundreds of cells durable, ~8 alive at any moment, all the rest hibernated — collapses if you try to run it metered. The cells stack is shaped to a particular substrate, and that substrate is owned hardware.

### Latency

Self-hosted also wins on latency, by physics:

- Cell-to-host RTT on local vmnet bridge: tens of microseconds.
- Cell-to-host RTT in cloud (cell on a VM, host control plane on another VM in the same datacenter): single-digit milliseconds at best.
- Cell-to-Pete (when Pete is in his apartment talking to a Mac in the same apartment): wifi + LAN + maybe one switch hop. Single-digit milliseconds.

The off-switch's "boom, off" experience requires the host's response to come back before the agent's next loop iteration. That's a microsecond budget. Only achievable on the same physical machine.

### The memory floor

Combine the off-switch with hot-tier pause and the system reaches the **theoretical minimum memory footprint** for a fleet of agents:

```
RAM used = Σ (cells currently generating tokens × cell size)
```

Nothing else. Cells between turns: 0 RAM. Cells hibernated: 0 RAM. Cells frozen in R2: 0 RAM. Cells crashed but not yet noticed: 0 RAM. The only RAM consumed at any given moment is the RAM holding the cells whose LLMs are actively producing output *right now*.

You cannot get below this. It's the floor. Any cell you want to be available has to be either alive (RAM cost = full size) or recoverable from somewhere (disk for hibernated, cloud for frozen). The off-switch ensures that every byte of RAM you're paying for is doing actual work — not waiting, not idling, not preserving "session warmth." Just generating.

This shape is unique to LLM agents because (a) their work is bursty (a turn is ~milliseconds-to-seconds of generation, then nothing for minutes-to-hours), and (b) their state is preservable (RAM contents are valid forever in a paused VM; nothing is "stale"). Both of those properties are the necessary conditions for the floor to be reachable. Outside this domain — say, a webserver that needs to respond to traffic at any moment — the floor is much higher because you can't pause between requests.

### What this implies for hardware planning

If you're spec-ing a host for the cells stack, the question stops being "how many agents do I want?" and becomes "**how many simultaneous turns do I want to support?**" Those are very different numbers. A team running 200 agents might have only 8 actively turning at peak — and 8 cells × 4GB each = 32GB RAM. A 48GB Mac Mini handles it; a 64GB or 128GB scales much further than the agent count would suggest. The cell count is bounded by *disk* (each hibernated cell is ~9GB), not RAM.

Pete's M5 Pro target spec: 48GB RAM, several TB of SSD. Supports ~8 simultaneous turns and hundreds of durable cells in steady state. The cooperation API is what makes this work; without the off-switch, the math collapses to "8 agents total."

## What this isn't

A few things to be honest about so the thesis doesn't get oversold:

- **Not "agents become fully autonomous."** They self-manage their lifecycle within bounds the operator sets. The operator still defines the resource ceiling, the trust model, the policy. The agent's agency is bounded.
- **Not "no orchestrator needed."** Pulse, splited, the cells CLI — all of these are orchestrators. They just delegate decision authority *down* (to the agent) instead of up.
- **Not "trust the LLM unconditionally."** The cooperation contract is small enough that an agent calling it correctly is a low bar. We don't ask the agent to reason about resource policy or other agents' priorities — only its own busy state. The contract intentionally minimizes what the agent has to get right.
- **Not "work without humans."** Pete's the operator. He sets the policy, picks the defaults, watches the dashboards, intervenes when something goes wrong. The thesis is about the *normal-path* relationship between the agent and the substrate, not about removing humans.

## The aspiration

If this works at the scale of a few hundred cells on a Mac Mini, the natural next ambitions are:

- **Cross-cell cooperation.** Agents talking to agents about wake decisions, resource trades, work handoffs. Pulse already gestures at this; expand the protocol.
- **Self-tuning thresholds.** The watchdog's `auto_pause_seconds` is currently a hand-tuned number. With cooperative signaling, the agent could request its own threshold ("I do bursts of work; pause me after 1s of quiet"). Each cell tuned to its own pattern.
- **Self-healing.** A cell that detects it's wedged could request its own restart (the `--fresh` flag on wake). A cell that suspects another cell is wedged could ask for it to be reviewed.
- **Self-documenting.** A cell could maintain its own operational notes — what it's working on, what's blocked, what to read first. Every wake is a continuation of an explicit narrative the cell wrote for its future self.
- **Self-archiving.** A cell that decides its work is done could request to be moved to Frozen tier (R2 offload) and forget about itself. The system acquires permanent record without permanent compute cost.

None of these need to be designed up front. They each become possible once the substrate respects agent agency over lifecycle.

## Historical resonances

The thesis echoes a few older ideas worth knowing:

- **Cooperative vs preemptive scheduling.** Early operating systems (cooperative multitasking, classic Mac OS pre-X) let processes yield voluntarily. Preemptive scheduling (Unix, modern OSes) was an improvement when processes couldn't be trusted to yield reliably. With *AI agents* — which are programmable about their yield behavior — cooperative scheduling becomes attractive again. The cost of misbehaving is bounded; the upside of cooperating is huge.
- **Erlang/BEAM lightweight processes.** Hundreds of thousands of processes per node, each with its own state, communicating by message-passing, restarting cheaply on failure. Self-managing agents are the LLM-era version of the BEAM mental model.
- **Continuations and green threads.** Pause-resume preserving full execution state has been a programming-language concept for decades. Splited's hot tier is essentially continuations for VM-level agents.
- **Greenfield "agent OS" thinking.** A bunch of recent OSS projects (langgraph, autogen, openagents) imagine agents as first-class OS-level citizens. The cells stack lands in this space but pushes harder on the lifecycle-control primitive.
- **The Unix philosophy, stretched.** "Do one thing well. Compose with pipes." The composition primitive in our stack is HTTP traffic + cooperative state signaling. Agents pipe to agents like `cat | grep | wc`.

## Open questions

These are the ones I think we'll have to answer eventually:

1. **Identity persistence.** When a cell wakes from Frozen tier (cloud storage), is it the *same* agent? What about across kernel updates that force a `--fresh` boot? The thesis presumes continuity; the implementation has gaps.
2. **Resource arbitration.** When 16 cells all want to be alive on an 8-cell machine, who decides who gets demoted? Today: longest-idle. Tomorrow: more nuanced (priority? user request? cell-level voting?).
3. **The contract between agent and substrate.** Today it's two verbs. Will it grow? Should we resist that or embrace it? Each new verb is leverage but also coupling.
4. **Multi-host across labs.** Pete's M5 Pro is one Lab. A team's Lab might be three Mac Minis + a Hetzner box. How do alive cells migrate between labs without losing continuity? (Hint: Frozen tier + restore is the migration path. But we haven't tested it.)
5. **Adversarial cells.** A compromised cell could pretend to be busy forever, pinning resources. Today's trust model is "single-tenant Mac, network-scope auth." Multi-tenant Colony deployment will need real auth and per-cell quotas.

## Closing

The kernel of the great idea: **intelligence ought to participate in its own resource management, because nobody else has the information to do it well.** Splited gives cells two levers; pi exposes their internal state via hooks; pulse handles intent at a higher level. The whole stack is just enough scaffolding for the agent to be in charge of itself.

If it works, the system grows by adding agents, not by adding orchestration. The operator's job stays roughly the same shape regardless of cell count. And the agents themselves get to be… the agents.
