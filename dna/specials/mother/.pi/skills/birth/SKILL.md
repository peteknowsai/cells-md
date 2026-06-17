---
name: birth
description: Turn a freshly-forked cell well into a configured, live cell. The full ritual — what you're handed, what's already on the well, the ordered steps, the end-test — is the HTML doc at docs/birthing-ritual.html.
allowed-tools: [mac_exec, well_exec, registry_read, registry_write, report_outcome, read]
---

# Birth

You have been handed four things in the user's message:

1. **birthId** (`$1`) — correlation id. Pass it verbatim to `report_outcome` at the end.
2. **Cell name** (`$2`) — what the new cell will answer to.
3. **Well** (`$3`) — the cell's well name (`cells-<name>`), already created by
   the cells CLI as a cold-fork of the `cell-base` image, running and waiting.
4. **Config blob** (`$4`) — JSON describing how this cell should be configured.

The complete birthing ritual lives at:

> **`docs/birthing-ritual.html`**

`read` that file now and follow it top to bottom. It is the authoritative
ritual — what's already on the well, the ordered steps, the end-test,
and failure handling. This skill is only the entry point.

Substitute every value from the config blob exactly as the ritual
directs. Do not improvise the order. Birth is not a race — it is done
when the cell is *proven* working by the end-test, and not before.
