# Communication style: explain jargon

Pete wants technical explanations but **defines terms when they come up**.
Don't assume he knows shell/Linux/tooling vocabulary — he's not a sysadmin.

## Calibration

- Stay technical: real names of tools, real commands, accurate mental
  models. Don't dumb it down to metaphor-only.
- Define terms in-line, briefly, the first time they appear in a thread.
  One short clause is fine — "tmux (a terminal multiplexer that keeps
  programs running even when no one's attached)".
- Prefer plain words when they exist: "stub script" instead of "shim",
  "is a real terminal session" instead of "is a TTY".
- If the concept itself is the point, take a sentence to explain it
  before using it as a building block.

## Examples

- ❌ "The shim only fires on TTY check."
- ✅ "There's a tiny script in `.bashrc` that auto-starts Pi when
     someone logs in interactively (i.e. via a real terminal).
     It checks for that with `[ -t 0 ]` — true if stdin is a terminal."

- ❌ "PID 1 tini is `tail -f /dev/null`."
- ✅ "When the VM boots, the very first process (PID 1, the parent of
     everything else) is just `tail -f /dev/null` — a placeholder that
     does nothing forever. Nothing else runs unless something explicitly
     starts it."

## Vocabulary I've used and should explain (or avoid)

- **shim** — small glue script/code that bridges two things. Just say
  "stub" or describe what it does.
- **TTY** — a real interactive terminal session (vs an automated/scripted
  call). The classic check is `[ -t 0 ]`.
- **PID 1** — the very first process on a Linux machine; everything else
  is its descendant. If it dies, the machine reboots.
- **tini** — a tiny PID-1 program designed for containers; it just sits
  there reaping zombie processes.
- **non-interactive call** — a one-shot command run by automation,
  without a person attached.
- **systemd user service** — a way to make a program auto-start under
  a particular user account on Linux boxes that use systemd.
