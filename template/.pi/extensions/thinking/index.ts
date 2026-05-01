/**
 * thinking — `/thinking` slash command.
 *
 * `/thinking` opens a picker (arrow + enter). `/thinking <level>` sets
 * directly. pi's setThinkingLevel clamps to model capabilities, so
 * passing a level the model doesn't support snaps to the nearest one
 * — we surface the clamp so the caller knows what they actually got.
 */

// `adaptive` requires the cell-side anthropic.js patch from
// configure-cell-proxy.sh step 3 to behave correctly (effort: undefined
// in the adaptive wire format). On non-opus models it silently behaves
// like "high" via pi-ai's default branch.
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"] as const;

export default function (pi: any) {
  pi.registerCommand("thinking", {
    description: "Show or set thinking level (off|minimal|low|medium|high|xhigh|adaptive)",
    getArgumentCompletions: (prefix: string) =>
      LEVELS.filter((l) => l.startsWith(prefix.toLowerCase())).map((l) => ({
        value: l,
        label: l,
      })),
    handler: async (args: string, ctx: any) => {
      let level = args.trim().toLowerCase();

      if (!level) {
        const current = pi.getThinkingLevel();
        const choice = await ctx.ui.select(
          `thinking level (current: ${current})`,
          [...LEVELS],
        );
        if (!choice) return;
        level = choice;
      }

      if (!(LEVELS as readonly string[]).includes(level)) {
        ctx.ui.notify(
          `unknown level '${level}'. valid: ${LEVELS.join(", ")}`,
          "error",
        );
        return;
      }

      pi.setThinkingLevel(level);
      const after = pi.getThinkingLevel();
      if (after !== level) {
        ctx.ui.notify(
          `thinking: '${level}' clamped to '${after}' (model max)`,
          "warning",
        );
      } else {
        ctx.ui.notify(`thinking: ${after}`);
      }
    },
  });
}
