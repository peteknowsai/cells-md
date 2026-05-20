# Jury Pool — cells port

A multi-cell colony where 9 philosopher cells deliberate, with a foreman cell that calls them in parallel and synthesizes the verdict. Example of a non-trivial fleet structure.

See also the colony showcase at `colonies/jurypool/`.

## Architecture

- **9 juror cells**: `jesus`, `buddha`, `rumi`, `marcus-aurelius`, `lao-tzu`, `confucius`, `tesla`, `fuller`, `gandhi` — each a normal cell with its philosopher persona baked into `SOUL.md`. Carry `memory` + `dream` extensions for cross-deliberation recall.
- **1 foreman cell**: `foreman` — also a normal cell, but additionally carries the `deliberate` extension (in `extension/deliberate/`). Foreman talks to the jury via wells HTTP API exec → `pi -p` on each juror in parallel.

## Birth

```bash
bash projects/jury/birth-jury.sh         # birth all 10
bash projects/jury/birth-jury.sh foreman # one at a time
```

After all are alive: `cells talk foreman "<question>"`.

## Files

- `personas/` — philosopher personas baked into each juror cell's `SOUL.md` at birth.
- `extension/deliberate/` — the foreman's tool. Pushed to foreman cell only post-birth.
- `birth-jury.sh` — orchestrates birth + persona injection + deliberate-extension installation.
