// `cells agents` — the fleet cockpit. One screen for the whole fleet:
// every cell grouped by project (or power state), with live awake/asleep
// status from welld, the way Claude Code's `claude agents` is one screen for
// every background session.
//
// This file is the VIEW only. It renders, navigates, retags (a pure registry
// write), and toggles grouping inline — but the heavy actions that take over
// the terminal (attach to a cell's TUI, talk to it, birth a new one) are
// returned to the launcher loop in cmdAgents() as an AgentsAction. The
// launcher unmounts the view, runs the action with inherited stdio, then
// re-renders a fresh view. Mirrors the render/unmount pattern in birth-ui.tsx.

import React, { useEffect, useState } from "react";
import { Box, Text, render, useInput } from "ink";
import {
  type FleetCell,
  type FleetSnapshot,
  type Grouping,
  flattenRows,
  formatAge,
  fleetCounts,
  groupFleet,
  loadFleet,
} from "./lib/fleet";
import { mutateRegistry } from "./lib/registry";

const VIOLET = "#9D7CD8"; // the fleet color (shared with birth-ui.tsx)
const REFRESH_MS = 4000;

export type AgentsAction =
  | { type: "quit" }
  | { type: "attach"; name: string }
  | { type: "talk"; name: string }
  | { type: "birth"; name?: string; project?: string };

export type AgentsViewOpts = {
  initialGrouping?: Grouping;
  projectFilter?: string | null;
  selectName?: string | null;
};

// What runAgentsView resolves with: the action to run, plus the view state
// so the launcher can restore grouping + selection on the next render.
export type AgentsViewResult = {
  action: AgentsAction;
  grouping: Grouping;
  selectName: string | null;
};

type Mode = "list" | "birth" | "retag" | "help";

// ── Per-cell row ──────────────────────────────────────────────────────────

function powerGlyph(c: FleetCell): { glyph: string; color: string } {
  if (c.health !== "ok") return { glyph: "⚠", color: "red" };
  if (c.special || c.pinned) return { glyph: "◆", color: VIOLET };
  if (c.power === "awake") return { glyph: "●", color: "green" };
  if (c.power === "asleep") return { glyph: "○", color: "gray" };
  return { glyph: "·", color: "gray" };
}

function powerLabel(c: FleetCell): { text: string; color: string } {
  if (c.health === "confirmed") return { text: "wedged", color: "red" };
  if (c.health === "suspected") return { text: "check", color: "yellow" };
  if (c.power === "awake") return { text: "awake", color: "green" };
  if (c.power === "asleep") return { text: "asleep", color: "gray" };
  return { text: "—", color: "gray" };
}

// Fixed-width fields keep the columns aligned regardless of name/model
// length — pad short, ellipsize long.
function fit(s: string, width: number): string {
  if (s.length > width) return s.slice(0, width - 1) + "…";
  return s.padEnd(width);
}

function CellRow({ cell, selected, nameWidth }: { cell: FleetCell; selected: boolean; nameWidth: number }) {
  const { glyph, color } = powerGlyph(cell);
  const pw = powerLabel(cell);
  const name = fit(cell.name, nameWidth);
  const spec = fit(`${cell.harness}·${cell.model}`, 24);
  return (
    <Box>
      <Text color={selected ? VIOLET : undefined}>{selected ? "❯ " : "  "}</Text>
      <Text color={color}>{glyph} </Text>
      <Text bold={selected} color={selected ? VIOLET : undefined}>
        {name}
      </Text>
      <Text dimColor>{spec}</Text>
      <Text color={pw.color}>{pw.text.padEnd(8)}</Text>
      <Text dimColor>{cell.pinned || cell.special ? "pinned  " : "        "}</Text>
      <Text dimColor>{formatAge(cell.ageMinutes).padStart(4)}</Text>
    </Box>
  );
}

// ── Header / footer ─────────────────────────────────────────────────────

function Header({ snap, grouping }: { snap: FleetSnapshot; grouping: Grouping }) {
  const c = fleetCounts(snap.cells);
  const live = snap.welldReachable ? <Text color="green">live</Text> : <Text color="red">welld offline</Text>;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={VIOLET} bold>
          cells
        </Text>
        <Text dimColor> · agents</Text>
      </Box>
      <Box>
        <Text dimColor>
          {c.total} {c.total === 1 ? "cell" : "cells"} · {c.awake} awake · {c.asleep} asleep · {c.projects}{" "}
          {c.projects === 1 ? "project" : "projects"} · grouped by {grouping} ·{" "}
        </Text>
        {live}
      </Box>
    </Box>
  );
}

function Footer({
  mode,
  input,
  birthProject,
  retagName,
  status,
}: {
  mode: Mode;
  input: string;
  birthProject: string;
  retagName: string;
  status: string | null;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {status ? (
        <Text dimColor>{status}</Text>
      ) : null}
      {mode === "birth" ? (
        <Box>
          <Text color={VIOLET}>birth › </Text>
          <Text>{input}</Text>
          <Text color={VIOLET}>▏</Text>
          <Text dimColor>
            {"  "}new cell in {birthProject || "unassigned"} — name (blank = auto) · ↵ birth · esc cancel
          </Text>
        </Box>
      ) : mode === "retag" ? (
        <Box>
          <Text color={VIOLET}>retag {retagName} › </Text>
          <Text>{input}</Text>
          <Text color={VIOLET}>▏</Text>
          <Text dimColor>
            {"  "}new project (blank clears) · ↵ save · esc cancel
          </Text>
        </Box>
      ) : (
        <Text dimColor>↑↓ move · ↵ open · space talk · n new · r retag · g regroup · ? help · q quit</Text>
      )}
    </Box>
  );
}

const SHORTCUTS: [string, string][] = [
  ["↑ / ↓  (j / k)", "move between cells"],
  ["↵  or  →", "attach — drop into the cell's own TUI"],
  ["space", "talk — open a conversation with the cell"],
  ["n", "birth a new cell into the selected project"],
  ["r", "retag the selected cell's project"],
  ["g", "regroup: by project ↔ by power state"],
  ["?", "toggle this help"],
  ["q  or  esc", "quit"],
];

function Help() {
  return (
    <Box flexDirection="column">
      <Text bold color={VIOLET}>
        shortcuts
      </Text>
      {SHORTCUTS.map(([k, d]) => (
        <Box key={k}>
          <Text color={VIOLET}>{k.padEnd(18)}</Text>
          <Text dimColor>{d}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>any key returns to the fleet</Text>
      </Box>
    </Box>
  );
}

// ── The view ──────────────────────────────────────────────────────────────

// Exported for the render smoke test (cli/lib/fleet covers the pure logic;
// this lets a test mount the real component with a fake TTY stdin and assert
// it paints live fleet data without throwing). Production entry is
// runAgentsView below.
export function AgentsView({
  opts,
  onExit,
}: {
  opts: AgentsViewOpts;
  onExit: (r: AgentsViewResult) => void;
}) {
  const [snap, setSnap] = useState<FleetSnapshot | null>(null);
  const [grouping, setGrouping] = useState<Grouping>(opts.initialGrouping ?? "project");
  const [selectedName, setSelectedName] = useState<string | null>(opts.selectName ?? null);
  const [mode, setMode] = useState<Mode>("list");
  const [input, setInput] = useState("");
  const [birthProject, setBirthProject] = useState("");
  const [retagName, setRetagName] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  // Load now + poll. Selection is tracked by name, so a refresh that reorders
  // or drops cells never makes the cursor jump to the wrong row.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const s = await loadFleet();
      if (alive) setSnap(s);
    };
    void refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Apply the optional project filter, then group + flatten for display.
  const cells = (snap?.cells ?? []).filter((c) => !opts.projectFilter || c.project === opts.projectFilter);
  const groups = groupFleet(cells, grouping);
  const rows = flattenRows(groups);
  const cellRows = rows.flatMap((r) => (r.kind === "cell" ? [r] : []));
  const nameWidth = Math.min(28, Math.max(8, ...cells.map((c) => c.name.length), 8) + 2);

  let selIdx = cellRows.findIndex((r) => r.cell.name === selectedName);
  if (selIdx < 0) selIdx = 0;
  const selectedRow = cellRows[selIdx];
  const selectedCell = selectedRow?.cell ?? null;

  // Hand the action back to the launcher loop. onExit unmounts the view
  // (Ink restores the terminal + raw mode), which resolves runAgentsView's
  // promise — matching birth-ui.tsx's unmount-to-resolve pattern.
  const finish = (action: AgentsAction) => {
    onExit({ action, grouping, selectName: selectedCell?.name ?? selectedName ?? null });
  };

  const moveSelection = (delta: number) => {
    if (cellRows.length === 0) return;
    const next = Math.max(0, Math.min(cellRows.length - 1, selIdx + delta));
    setSelectedName(cellRows[next]!.cell.name);
  };

  const doRetag = async () => {
    const name = retagName;
    const project = input.trim();
    // Locked read-modify-write so the cockpit retag can't clobber a concurrent
    // birth/operator write (mirrors cells project).
    await mutateRegistry((cells) =>
      cells.map((c) => {
        if (c.name !== name) return c;
        if (project) return { ...c, project };
        const { project: _drop, ...rest } = c;
        return rest;
      }),
    );
    setStatus(project ? `retagged ${name} → ${project}` : `cleared ${name}'s project`);
    setMode("list");
    setInput("");
    setSnap(await loadFleet());
  };

  useInput((ch, key) => {
    // Help: any key dismisses.
    if (mode === "help") {
      setMode("list");
      return;
    }

    // Text-entry modes (birth, retag) share editing semantics.
    if (mode === "birth" || mode === "retag") {
      if (key.escape) {
        setMode("list");
        setInput("");
        return;
      }
      if (key.return) {
        if (mode === "birth") {
          finish({ type: "birth", name: input.trim() || undefined, project: birthProject || undefined });
        } else {
          void doRetag();
        }
        return;
      }
      if (key.backspace || key.delete) {
        setInput((s) => s.slice(0, -1));
        return;
      }
      // Append printable input (ignore control chords).
      if (ch && !key.ctrl && !key.meta && ch.charCodeAt(0) >= 32) {
        setInput((s) => s + ch);
      }
      return;
    }

    // ── list mode ──
    if (key.ctrl && ch === "c") return finish({ type: "quit" });
    if (key.escape || ch === "q") return finish({ type: "quit" });
    if (key.upArrow || ch === "k") return moveSelection(-1);
    if (key.downArrow || ch === "j") return moveSelection(1);
    if (ch === "g") {
      setGrouping((g) => (g === "project" ? "state" : "project"));
      setStatus(null);
      return;
    }
    if (ch === "?") {
      setMode("help");
      return;
    }
    if (ch === "n") {
      // Default the new cell's project to the selected group, when that
      // group is a real project (not operators / unassigned / state mode).
      const grp = selectedRow?.group;
      setBirthProject(grp && grp.kind === "project" && grp.label !== "unassigned" ? grp.label : "");
      setInput("");
      setStatus(null);
      setMode("birth");
      return;
    }
    if (!selectedCell) return; // remaining actions need a selection
    if (ch === "r") {
      setRetagName(selectedCell.name);
      setInput(selectedCell.project);
      setStatus(null);
      setMode("retag");
      return;
    }
    if (key.return || key.rightArrow) return finish({ type: "attach", name: selectedCell.name });
    if (ch === " ") return finish({ type: "talk", name: selectedCell.name });
  });

  if (!snap) {
    return (
      <Box padding={1}>
        <Text dimColor>loading fleet…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Header snap={snap} grouping={grouping} />
      {mode === "help" ? (
        <Help />
      ) : cellRows.length === 0 ? (
        <Text dimColor>no cells here yet — press n to birth one</Text>
      ) : (
        rows.map((r, i) =>
          r.kind === "header" ? (
            <Box key={`h-${r.group.key}`} marginTop={i === 0 ? 0 : 1}>
              <Text bold dimColor>
                {r.group.label}
              </Text>
            </Box>
          ) : (
            <CellRow
              key={`c-${r.cell.name}`}
              cell={r.cell}
              selected={r.cell.name === selectedCell?.name}
              nameWidth={nameWidth}
            />
          ),
        )
      )}
      <Footer mode={mode} input={input} birthProject={birthProject} retagName={retagName} status={status} />
    </Box>
  );
}

// Render the cockpit and resolve once the user picks an action that takes
// over the terminal (or quits). Clears the screen first for a clean takeover.
export function runAgentsView(opts: AgentsViewOpts = {}): Promise<AgentsViewResult> {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  return new Promise<AgentsViewResult>((resolve) => {
    const instance = render(
      <AgentsView
        opts={opts}
        onExit={(r) => {
          instance.unmount();
          resolve(r);
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
