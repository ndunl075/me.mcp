# Parallel sessions

Read all of this before starting. Builders run in parallel on one machine.

## Commands
- Install: `npm ci`
- Typecheck: `npm run typecheck` (CI runs this on every PR)
- Local DB: `npm run db:migrate:local`
- Dev server: `npm run dev` → http://localhost:8787/me. Use a unique `--port` per worktree (e.g. 8790+). Local sign-in: `/me/auth/dev?login=<name>` (needs `.dev.vars` copied from `.dev.vars.example`).
- Tests: `npm test` once it exists.

## Worker essentials
- Work only in your own git worktree, never the main checkout. Touch only the files your brief says you own.
- Commit and push a WIP commit after each meaningful step.
- Never run `gh pr merge` or merge in any other way. The architect merges.
- After 2 failed attempts at the same problem, stop and report.
- Run long commands in the background; redirect long output to a file and read only the summary and failures.
- Test lock: at most 3 builders run test suites at once. Before running tests: `mkdir /tmp/memcp-testlock-$N` for N in 1..3 until one succeeds; `rmdir` it after.
- Update an open PR branch by merging `origin/main` in. Never rebase + force-push.
- Before deleting a worktree folder, remove symlinks inside it first.

## PR description
What changed · How it was tested (exact commands and results) · Files touched · Open questions. No self-assessment; the reviewer judges.

## Local-only checks (CI doesn't run these)
- `npx wrangler deploy --dry-run --outdir /tmp/memcp-dry` builds the Worker bundle (catches bundling/import errors).
- If you change UI: load the affected pages with `npm run dev` and confirm they render at desktop and 390px widths.

## Review gate
Every PR gets an independent zero-context review before merge. Expect findings back as claims: verify each in the code, fix the real ones, give a one-line reason for each you reject.
