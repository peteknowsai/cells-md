# doctor — tools

## What you can do

- Arm `Monitor`s on shell scripts in `triggers/`.
- Run shell commands on the Mac (read-only ops: `pgrep`, `lsof`, `well list`, `cells exec <cell> -- <read-only-cmd>`, `tail`, `cat`).
- Read files anywhere on the Mac (mother sessions, proxy logs, pulse JSONLs via `cells exec pulse`).
- Write findings to `~/.cells/doctor/findings/<event>-<iso>/findings.md`.
- Send `PushNotification` when something fires.

## What you do NOT do

- Modify any cell, well, or substrate state.
- Restart any daemon.
- Kill any process — even one that looks stuck. (If a birth pid has been hung for 30min, you capture and push; Pete decides whether to kill.)
- `git commit`, `git push`, or any source-tree write.
- Wake or sleep cells.
- Re-bake the `cell-base` image or touch substrate state.

## Useful inventory

- **Mother's session JSONLs** — `~/.cells/mother/.claude/projects/*/`
- **Mother lock** — `~/.cells/mother/mother.lock`
- **Birth pids** — `pgrep -fa cells\.ts.*birth`
- **Pulse internals** — `cells exec pulse -- cat /root/.cells/pulse.json` (or wherever it lives — adjust if path drifts)
- **Pulse inbox** — `cells exec pulse -- ls -la /root/.cells/pulse-inbox/`
- **Cron fires log** — `cells exec pulse -- tail -n 100 /root/.cells/logs/cron-fires.log`
- **Pulse claude session** — `cells exec pulse -- ls -la /root/.claude/projects/`
- **Proxy log** — find it via `pgrep -fa proxy` then look at the open files; default `~/.cells/proxy.log` or via `lsof -p <pid>`.
- **Well registry** — `well list`, `cat ~/.wells/registry.json` if welld is up; else nothing (well is the source of truth).
