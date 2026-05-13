// Birth-time progress animation, rendered with React Ink.
//
// Dynamic-tempo: 4 stages of 500ms each (2s nominal). The animation honors:
//   - minDurationMs (default 1500ms): floor so the user always feels the
//     animation; firstTokenSeen resolving sooner doesn't truncate it.
//   - endSignal: when this resolves AND we've passed minDurationMs, the
//     animation snaps to the final stage and exits. In practice this fires
//     when pi streams its first byte back to captureGreeting, so the
//     animation ends just as the greeting is about to print.
//   - maxDurationMs (default 6000ms): cap. Cold pool-member paths can take >5s to
//     thaw+start pi+LLM-RT; we don't want the animation hanging forever.
//
// Mounts via `runBirthAnimation()` from cli/cells.ts in cmdCreateV1Fast.
// Returns when the animation is done. Caller starts captureGreeting() in
// parallel and reads its `release()` after this returns to drain the
// buffered greeting to stdout.
//
// Renders (4 stages, ~500ms each at base tempo):
//   ◉ ◯ ◯ ◯  waking
//   ◉ ◉ ◯ ◯  warming
//   ◉ ◉ ◉ ◯  ready
//   ◉ ◉ ◉ ◉  alive
import React, { useEffect, useState } from "react";
import { Box, Text, render } from "ink";

const STAGES = [
  { dots: "◉ ◯ ◯ ◯", label: "waking" },
  { dots: "◉ ◉ ◯ ◯", label: "warming" },
  { dots: "◉ ◉ ◉ ◯", label: "ready" },
  { dots: "◉ ◉ ◉ ◉", label: "alive" },
];

const BASE_STAGE_MS = 500;
const DEFAULT_MIN_MS = 1500;
const DEFAULT_MAX_MS = 6000;

// Fleet color — neutral muted violet, sets the cells aesthetic without
// committing to a per-cell color theme yet. Per-cell colors are v2 work.
const FLEET_COLOR = "#9D7CD8";

type BirthAnimProps = {
  startedAt: number;
  minDurationMs: number;
  maxDurationMs: number;
  endSignal: Promise<unknown> | null;
  onDone: () => void;
};

function BirthAnim({ startedAt, minDurationMs, maxDurationMs, endSignal, onDone }: BirthAnimProps) {
  const [stage, setStage] = useState(0);
  const [endRequested, setEndRequested] = useState(false);

  // Wire the end signal once. When it resolves we set endRequested; the
  // tick effect below decides whether we're past minDurationMs yet.
  useEffect(() => {
    let alive = true;
    endSignal?.then(() => { if (alive) setEndRequested(true); }).catch(() => {});
    return () => { alive = false; };
  }, [endSignal]);

  // Hard cap — never let the animation run past maxDurationMs.
  useEffect(() => {
    const elapsed = Date.now() - startedAt;
    const remainingToCap = Math.max(0, maxDurationMs - elapsed);
    const t = setTimeout(() => setEndRequested(true), remainingToCap);
    return () => clearTimeout(t);
  }, [startedAt, maxDurationMs]);

  // Stage progression. At normal tempo each stage is BASE_STAGE_MS. If
  // endRequested is set AND we've passed minDurationMs, snap to the
  // final stage and fire onDone after a short hold so the user sees
  // "alive" momentarily.
  useEffect(() => {
    const elapsed = Date.now() - startedAt;
    const pastMin = elapsed >= minDurationMs;

    if (endRequested && pastMin) {
      if (stage < STAGES.length - 1) {
        setStage(STAGES.length - 1); // snap to "alive"
        return;
      }
      // Already on final stage — short hold then exit.
      const t = setTimeout(onDone, 120);
      return () => clearTimeout(t);
    }

    // Normal tempo. Advance to next stage at BASE_STAGE_MS, but if we're
    // on the final stage and not endRequested, hold until either
    // endRequested fires or minDurationMs elapses, whichever is later.
    if (stage >= STAGES.length - 1) {
      // Re-check periodically so endRequested-after-min can fire onDone.
      const t = setTimeout(() => setStage(stage), 100);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStage(stage + 1), BASE_STAGE_MS);
    return () => clearTimeout(t);
  }, [stage, endRequested, startedAt, minDurationMs, onDone]);

  const current = STAGES[stage]!;
  return (
    <Box flexDirection="column">
      <Text color={FLEET_COLOR}>  {current.dots}  </Text>
      <Text dimColor>  {current.label}</Text>
    </Box>
  );
}

export type BirthAnimationOpts = {
  endSignal?: Promise<unknown>;
  minDurationMs?: number;
  maxDurationMs?: number;
};

export async function runBirthAnimation(opts: BirthAnimationOpts = {}): Promise<void> {
  const minDurationMs = opts.minDurationMs ?? DEFAULT_MIN_MS;
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_MS;
  const startedAt = Date.now();
  return new Promise<void>((resolve) => {
    const instance = render(
      <BirthAnim
        startedAt={startedAt}
        minDurationMs={minDurationMs}
        maxDurationMs={maxDurationMs}
        endSignal={opts.endSignal ?? null}
        onDone={() => {
          instance.unmount();
          resolve();
        }}
      />,
      // useStderr=false: animation goes to stdout. We unmount cleanly so
      // the talk prompt that follows starts on a fresh line.
      { exitOnCtrlC: false },
    );
  });
}
