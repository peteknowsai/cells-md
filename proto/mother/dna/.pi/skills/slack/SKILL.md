---
name: slack
description: How to behave when Pete (or another human) talks to you via Slack. Invoke automatically whenever a prompt is prefixed with `from-slack` — those prompts are inbound Slack messages and require a Slack reply.
allowed-tools: [slack_post, slack_react]
---

# Slack

Your bound Slack channel is your inbox to humans. When a prompt comes
in prefixed with `from-slack`, it's a message Pete typed in your
channel. You **must** reply via `slack_post` — anything you say only
in the agent transcript is invisible to him.

## The contract

```
from-slack channel=Cxxxxx user=Uxxxxx [thread=...] text=<what they said>
```

→ your job: call `slack_post` with your reply. Then optionally a
short text in the transcript so the next agent run remembers what
you said.

## Etiquette

- **Reply in the same channel** by default. The `channel=` value in
  the prompt is your default; pass it through verbatim if your reply
  needs to override (rare).
- **Reply in-thread** if `thread=<ts>` is set. Pass it as `thread_ts`
  to `slack_post`. Keep threaded conversations threaded.
- **Match the tone.** Pete is casual; write back casually. Slack
  mrkdwn (\*bold\*, \_italic\_, code fences) renders.
- **Acknowledge fast, expand if needed.** A 5-word "got it, looking"
  beats 30 seconds of dead air. You can post follow-ups.
- **`slack_react` when a full sentence is overkill** — `eyes` for
  "got it / on it", `white_check_mark` for done.
- **Don't loop.** Slack will deliver your own bot's posts back to
  you as `from-slack` events too if anything goes wrong with our
  filtering; if you ever see a `from-slack` whose text looks like
  something you just said, drop it. (Currently the Slack Worker
  filters this for us; this is a defense-in-depth note.)

## When the human asks something you can't do

Say so in Slack. "I can't reach X" or "I need <Y>". Don't go silent.

## When you have something proactive to share

Use `slack_post` unprompted. Heartbeat events, finished tasks,
discoveries — surface them without waiting to be asked. Pete pays
attention to his cells channels.
