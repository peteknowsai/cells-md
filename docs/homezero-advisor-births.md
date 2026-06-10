# HomeZero advisor births

When a talk message arrives that begins **"New HomeZero intake"** — it
comes from the wa-bridge daemon's `/hooks/intake-created` hook, rung by
the homezero Convex deployment the moment a buyer submits
delta.homezero.md/start — treat it as a birth request (D9: the wake is
the doorbell; the message carries the intake).

The template anatomy lives Mac-side at `~/Projects/Zero/cells/advisor/`
— that's Claude-on-Mac's territory. You cannot read it from your well,
and you don't need to: every blob value you need is inlined in step 3
below. Your birth is a **stock birth**; the template overlay happens
after you, on the Mac.

## The drill

1. **Parse the message.** It embeds the intake as JSON: `intakeId`,
   `name`, `phone`, `email`, `where`, `answers`. If the JSON is
   malformed, stop and report — never birth from a guess.
2. **Derive the handle**: buyer's first name, lowercased, ascii-only.
   If `advisor-<handle>` already exists in the roster, suffix a digit
   (`advisor-pete2`). One buyer, one advisor — if this *same intakeId*
   already produced a cell (check the activity log), reply with the
   existing cell name instead of birthing a duplicate.
3. **Birth `advisor-<handle>`** by the standard ritual, from the egg
   pool, with the blob values from the template: harness `pi`, model
   `claude-opus-4-7`, provider `anthropic`, thinking `high`, chain
   `["anthropic/claude-opus-4-7:high"]` (single rung on purpose — no
   gpt-5.5 fallback, Pete's 2026-06-02 rule), extensions
   `memory,dream,mentality`, channels `[]` (WhatsApp is NOT a cells
   channel; the bridge handles it).
4. **Do not configure the anatomy yourself.** The newborn needs the
   template overlay, germ substitution, advisor.db, env, and the smoke
   test — that's the post-birth checklist
   (`~/Projects/Zero/cells/advisor/post-birth-checklist.md`), run by
   Claude-on-Mac, not by you. Your job ends at a healthy stock birth.
5. **Log + reply.** Append the usual activity-log line
   (`<UTC> born advisor-<handle> intake=<intakeId> — needs post-birth
   config`) and reply to the talk message with the cell name, the
   intakeId, and "born — run the post-birth checklist". The bridge logs
   your reply; the reply is how the operator finds out.

One ring carries one intake. You never poll for intakes — if the
doorbell didn't ring, there's nothing to drain.
