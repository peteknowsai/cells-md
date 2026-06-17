---
name: birth
description: Turn a freshly-forked generic cell into a configured, live cell. Self-contained — everything is here.
---

# Birth

Execute the steps below in order. **Do not read other files. Do not grep
the codebase. Do not echo env vars to check them — they're set, trust it.**
Everything you need is in this skill.

## Inputs

The user message is `/birth <NAME> <WELL> <BLOB_JSON>`. Three
positional args after `/birth`. `$CELL_OUTCOME_FILE` is set in env — write
the final JSON there at the end.

## Step 1 · Imprint (one bash call)

Imprint the cell in one Mac-side script that handles identity + model config
+ status file + extensions. The script SSHes into the cell once and does
everything; no escaping pitfalls.

```bash
cd "${CELLS_REPO:-$HOME/Projects/cells}" && \
  bash scripts/imprint-cell.sh "<WELL>" "<NAME>" '<BLOB_JSON>'
```

Substitute the three positional args from the slash command. The blob
JSON goes in single quotes verbatim (it contains double quotes already).

The last line of output must be `BAKE-OK`. If it isn't, jump to **Failure**.

## Step 2 · End-test (proves the cell's brain works)

Pick by harness — same cell, different CLI:

```bash
# pi cells — sudo + HOME=/root so pi reads /root/.pi/. Without sudo, `well
# exec` lands as the `well` user with HOME=/home/well and the smoke test
# verifies the wrong config tree (not the one the live cell runs from).
# 60s (matching the claude-code end-test): pi + Anthropic now runs on the Max
# sub through the proxy with adaptive thinking, slower to first token than the
# retired direct paid-key path the old 30s budget was tuned for.
well exec -s "<WELL>" -- bash -lc "sudo bash -lc 'export HOME=/root; cd /root && source /etc/profile.d/cells-env.sh && timeout 60 pi --print \"say ok\"' && echo PI-OK"

# claude-code cells — sudo + HOME=/root so claude reads /root/.claude/. Same
# reason as pi: a bare `well exec` runs as `well` and tests /home/well/.claude.
well exec -s "<WELL>" -- bash -lc "sudo bash -lc 'export HOME=/root; cd /root && source /etc/profile.d/cells-env.sh && timeout 60 claude --print \"say ok\"' && echo CLAUDE-OK"

# codex cells — sudo + HOME=/root so codex reads /root/.codex/config.toml
# (the proxy-routing config that swaps OPENAI_CODEX_API_KEY for the real
# ChatGPT token). Without sudo, codex runs as `well` user with HOME=/home/well,
# misses the cells-routed config, and hits OpenAI's API direct → 401.
well exec -s "<WELL>" -- bash -lc "sudo bash -lc 'export HOME=/root; cd /root && source /etc/profile.d/cells-env.sh && timeout 120 codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \"say ok\" < /dev/null' && echo CODEX-OK"

# hermes cells — sudo + HOME=/root so hermes reads /root/.hermes/config.yaml
# (the cells provider that routes OPENAI_CODEX_API_KEY through
# proxy.cells.md/codex). `hermes -z` is hermes's one-shot mode: it prints
# just the final response text and exits.
well exec -s "<WELL>" -- bash -lc "sudo bash -lc 'export HOME=/root; cd /root && source /etc/profile.d/cells-env.sh && timeout 120 hermes -z \"say ok\"' && echo HERMES-OK"
```

Output must end with `PI-OK` / `CLAUDE-OK` / `CODEX-OK` / `HERMES-OK`. If not, the
cell's brain is broken — jump to **Failure**.

## Step 3 · Fire post-birth tasks in the background, then write outcome

Site service registration, Cloudflare Worker deploy, channel binding,
harness update, and the well checkpoint all run async — the cell is
already alive and you can already `cells talk` her. They land in the
background. Mother does not wait.

`scripts/birth-postwork.sh` runs them in order and writes per-step
status to `~/.cells/postwork/<NAME>.json` so failures don't go silent
(the dashboard picks the file up; nothing else needs to change for
visibility).

```bash
POSTLOG="$HOME/.cells/logs/birth-postwork/<NAME>.log"
mkdir -p "$(dirname "$POSTLOG")"
nohup bash "${CELLS_REPO:-$HOME/Projects/cells}/scripts/birth-postwork.sh" \
  "<NAME>" "<WELL>" '<BLOB_JSON>' > "$POSTLOG" 2>&1 &
disown

# Write outcome — birth is done.
echo "{\"success\":true,\"message\":\"cell <NAME> alive · <MODEL> (post-birth async)\"}" > "$CELL_OUTCOME_FILE"
```

Substitute `<NAME>`, `<WELL>`, `<MODEL>` (from the blob). After the
outcome write, print exactly:

> Cell `<NAME>` is alive. Talk to it with `cells talk <NAME>`.

Stop. No further checks, no memory writes, no exploration.

## Failure

Any gated step fails (`BAKE-OK` missing, end-test wrong):

```bash
echo "{\"success\":false,\"message\":\"step <N>: <one-line reason>\"}" > "$CELL_OUTCOME_FILE"
```

Then stop. The CLI will sweep the cell.
