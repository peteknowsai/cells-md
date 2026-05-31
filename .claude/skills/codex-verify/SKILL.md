---
name: codex-verify
description: Use Codex (GPT-5.5, OpenAI) as an independent second-opinion reviewer of your own work — a different model lineage reading your diff cold. Trigger after committing a logically-risky change (security/auth, parsing/migration, concurrency, a script↔code contract, anything where "looks right" isn't enough) and you want adversarial verification before trusting it. Also use when the user asks to "verify with codex", "have codex check this", or "second-opinion this". Codex runs locally via the `codex` CLI on Pete's ChatGPT subscription (flat cost, no API billing). Do NOT use for trivial doc/rename/formatting changes — xhigh review costs minutes.
---

# codex-verify — independent review with Codex

Codex is a second pair of eyes from a different model family. It doesn't
just read the diff — it spawns an agent that builds, greps, runs tests,
and reasons about your change, then returns a verdict. Use it to catch
what you can't see in your own work.

## The core loop

Verification is worthless if you fire it and forget it. **A step isn't
done until you've read its Codex verdict.** The loop:

1. Make the change, build + test it yourself.
2. Commit it (Codex's `review --commit` needs a sha).
3. Fire the review **in the background** (xhigh ≈ minutes — don't block on it):
   ```
   codex exec review --commit <sha> -c model_reasoning_effort="xhigh" > /tmp/codex-<sha>.txt 2>&1
   ```
4. Keep working on the next step while it reviews.
5. When it lands, **read the verdict.** If it flags something real, fix it
   in a follow-up commit that credits the catch (honest history showing the
   verifier worked). If it's clean, say so and move on.

## Invocations

Pete's `~/.codex/config.toml` already defaults to `model = "gpt-5.5"` and
`model_reasoning_effort = "xhigh"` — the `-c` override is belt-and-suspenders.

- **Review one commit** (most common — verify what you just shipped):
  ```
  codex exec review --commit <sha> -c model_reasoning_effort="xhigh"
  ```
- **Review uncommitted changes** before committing (accepts a focus prompt):
  ```
  codex exec review --uncommitted -c model_reasoning_effort="xhigh" "Focus on the lock logic."
  ```
- **Review the whole branch** against a base (end-of-batch backstop):
  ```
  codex exec review --base main -c model_reasoning_effort="xhigh"
  ```

## Gotchas (learned the hard way)

- `-s read-only` is **not** valid on the `review` subcommand — review is
  inherently read-only. Passing `-s` errors out. (It's a flag for plain
  `codex exec`, not `codex exec review`.)
- `--commit <sha>` **cannot** be combined with a custom `[PROMPT]` — the
  commit is the subject, Codex uses its built-in review criteria. Use
  `--uncommitted` or `--base` if you need to focus the review with a prompt.
- xhigh reviews take minutes — always run in the background, never inline.
- Pete's Codex has some hooks (`UserPromptSubmit`, `Stop`) that print
  "Failed" — harmless noise, the review still runs and returns.

## When to spend it

Spend Codex review on changes where correctness isn't obvious from reading:

- security / auth / path-containment / input validation
- parsing, migration, or serialization (silent data corruption risk)
- concurrency, locks, atomic file ops
- a contract between a script and code (e.g. a bash writer + a TS reader)
- anything touching money, deletion, or the birth/kill critical path

Skip it for: doc edits, renames, formatting, comment changes, test-only
additions with no logic. Your own `bun test` + build already covers those.
