// Birth-time progress animation, rendered with React Ink.
//
// Fixed-tempo: 4 stages × ~750ms each = ~3s total. Decoupled from the
// real birth pipeline that runs in parallel — the animation is theater,
// signalling intent to the user. The cell may be ready before the
// animation finishes (warm pool) or slightly after (cold fork), but the
// user experiences a consistent rhythm either way.
//
// Mounts via `runBirthAnimation()` from cli/cells.ts in cmdCreateV1Fast.
// Returns when the animation is done. Caller is responsible for
// awaiting the real birth pipeline in parallel and then dropping the
// user into the talk session.
//
// Renders (each stage shown for ~750ms):
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

const STAGE_DURATION_MS = 750;

// Fleet color — neutral muted violet, sets the cells aesthetic without
// committing to a per-cell color theme yet. Per-cell colors are v2 work.
const FLEET_COLOR = "#9D7CD8";

function BirthAnim({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (stage >= STAGES.length - 1) {
      // Hold on the final stage briefly so "alive" registers, then unmount.
      const t = setTimeout(onDone, STAGE_DURATION_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStage(stage + 1), STAGE_DURATION_MS);
    return () => clearTimeout(t);
  }, [stage, onDone]);

  const current = STAGES[stage]!;
  return (
    <Box flexDirection="column">
      <Text color={FLEET_COLOR}>  {current.dots}  </Text>
      <Text dimColor>  {current.label}</Text>
    </Box>
  );
}

export async function runBirthAnimation(): Promise<void> {
  return new Promise<void>((resolve) => {
    const instance = render(
      <BirthAnim
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
