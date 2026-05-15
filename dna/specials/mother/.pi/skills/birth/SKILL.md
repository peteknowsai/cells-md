---
name: birth
description: Turn a claimed generic egg into a configured, live cell. The full ritual — what you're handed, what's on the egg, the ordered steps, the end-test — is the HTML doc at docs/birthing-ritual.html.
allowed-tools: [bash, well_exec, well_checkpoint, report_outcome, read]
---

# Birth

You have been handed three things in the user's message:

1. **Cell name** — what the new cell will answer to.
2. **Egg** — the well name of a claimed generic egg from the pool.
3. **Config blob** — JSON describing how this cell should be configured.

The complete birthing ritual lives at:

> **`docs/birthing-ritual.html`**

`read` that file now and follow it top to bottom. It is the authoritative
ritual — what's already on the egg, the nine ordered steps, the end-test,
and failure handling. This skill is only the entry point.

Substitute every value from the config blob exactly as the ritual
directs. Do not improvise the order. Birth is not a race — it is done
when the cell is *proven* working by the end-test, and not before.
