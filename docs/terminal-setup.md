# Terminal Setup

The standard terminal editing setup for all our machines (macOS + Linux). Goal: open a terminal, find a file, edit it, save, get out — without becoming a vim ninja.

## The stack

| Tool | Role |
|---|---|
| **micro** | Editor. Normal keybindings (Ctrl+S, Ctrl+Q, Ctrl+C/V/X). No modes, mouse works. |
| **fzf** | Fuzzy file picker. Type a few letters, narrow the list, hit Enter. |
| **ripgrep** (`rg`) | Feeds fzf its file list. Respects `.gitignore` so we never see `node_modules` or `.git`. |
| **bat** | Syntax-highlighted previews inside the fzf window. Also a nicer `cat`. |

That's it. Four tools, one workflow.

## Commands we add to the shell

Two shell entries on top of the tools above:

### `mf` — fuzzy pick anywhere in the tree

Recursive search from the current directory. Skips anything in `.gitignore`. Shows a live preview of the highlighted file on the right.

```
~/projects $ mf
> tours          # type a few letters
paria/tours.jsx  # Enter → opens in micro
```

Best when you roughly know the filename.

### `mft` — browse mode

Step into folders, back out with `..`, open a file when you find one. Behaves like a minimal file manager.

```
~/projects $ mft
./paonia-truth-feed > [pick folder to descend, file to open, .. to go up]
```

Best when you're poking around unfamiliar territory.

## How it's wired

Three additions to the shell rc file (`.zshrc` on macOS, `.bashrc` or `.zshrc` on Linux):

1. **`FZF_DEFAULT_COMMAND`** — tells fzf to source its file list from `rg --files --hidden --glob "!.git"`. This is what makes fzf gitignore-aware.

2. **`FZF_DEFAULT_OPTS`** — sets the visual layout: 80% height, reverse layout, border, and a preview pane on the right that runs `bat --style=numbers --color=always --line-range=:300 {}` for syntax highlighting (with `ls -la {}` as a fallback for non-text files and directories).

3. **`mf` alias and `mft` function** — `mf` is a one-shot `micro "$(fzf)"`. `mft` is a small loop: pick → if directory descend, if file open, `..` to go up.

## Editing in micro

Six keys cover almost everything:

| Key | Action |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+Q` | Quit |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+C` / `Ctrl+V` / `Ctrl+X` | Copy / paste / cut |
| `Ctrl+F` | Find (then `Ctrl+N` for next) |
| `Ctrl+G` | Help — full keybind list |

Selection works with shift+arrows or mouse drag. Mouse clicks position the cursor.

## What this setup deliberately is NOT

- **Not vim/neovim.** Different mental model, much steeper curve, not needed for the "edit a file" workflow.
- **Not tmux.** Multiplexing is a separate concern; add it only when running multiple long-lived processes.
- **Not zoxide / `z`.** Smart `cd` is nice but solves a problem most people don't have yet.
- **Not lazygit / TUI dashboards.** Resist the rabbit hole. Add tools when friction is felt, not before.

The whole point is a small, predictable surface that works the same on every machine.
