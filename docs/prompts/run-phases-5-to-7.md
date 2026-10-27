## What happened
My local copy of this project was lost. The last good state is on GitHub (private repo https://github.com/wesamalhroubuni-rgb/hz-operations-app, branch main). It contains Phases 1–4, committed and pushed on 2026-10-17. Any Phase 5 work done after that was never pushed and is gone. MEMORY.md on GitHub still says Phase 4 is "not committed": that's outdated — it is commit 280c50a.

The `.env` file and the local database were not in git. Recreate `.env` from `.env.example` and the demo data with `pnpm db:reset`.

## What I need
I'm late on delivery. Run **Phases 5, 6 and 7 back to back without waiting for me between phases**. I will test everything myself after Phase 7.

Prompts: docs/prompts/phase-5.md, phase-6.md, phase-7.md. Ignore the WORKING DIRECTORY line inside them and use this repository's folder. In phase-5.md, the remarks about "this PC is Ethernet-only" and the lab PC are history; keep the Android emulator setup if practical.

## Step 0 — Recover and verify
1. Confirm you are in the cloned repo on `main` at commit 280c50a or later; fetch from origin.
2. Check the machine has Node LTS, pnpm, Git and Docker Desktop running. If something is missing or needs a restart, tell me exactly what and stop until I confirm.
3. Create `.env` from `.env.example`, then run `pnpm install`, `pnpm db:up`, `pnpm db:reset` (if the permission system blocks it, ask me to run it), build, lint, typecheck, test and `pnpm test:integration`. Fix anything broken.
4. Correct MEMORY.md (Phase 4 is committed; the phone test is still pending; the local copy was lost and restored from GitHub on today's date).
5. Commit "Restore after local data loss: update MEMORY.md" and push.

## Then, for each phase 5 → 6 → 7
1. Execute the phase prompt fully, including its subagents (test-writer, reviewer, docs-keeper).
2. **Quality gate before moving on:** build, lint, typecheck, test, test:integration and format:check all pass, and the reviewer has no unresolved blocking findings.
3. Write `docs/reports/phase-N.md` with the end-of-change summary from AGENTS.md and that phase's manual test steps.
4. Update MEMORY.md, then **commit "Phase N: …" and push to origin/main.** This is a standing exception to "do not commit": I want every phase pushed so nothing can be lost again. Never commit `.env`, secrets or local data.
5. Continue to the next phase without waiting for me.

## When to stop and ask me
Only stop if:
- a decision can't be undone and could reasonably go either way;
- you need something only I can provide (an account, a payment, a password, a physical action such as a restart);
- a quality gate keeps failing after reasonable attempts.

Missing AI API keys are not a reason to stop: Phase 7 uses fake providers until I add keys. For any other judgment call, take the recommended option, record it in MEMORY.md and the phase report, and continue.

If you run low on context, write the current state to MEMORY.md and the phase report, commit and push, and tell me exactly what to paste into a new session to continue.

## At the end
Give me:
- a short overall summary of Phases 5–7;
- the list of everything still pending (phone test, API keys, Phase 8 items);
- one combined manual test plan for Phases 4–7 (web + Android emulator or phone), in order, with the demo logins from the README.
