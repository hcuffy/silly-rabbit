---
name: code-review
description: >
  Review staged/diff changes in silly-rabbit against CLAUDE.md's settled decisions and
  code rules, target-agnostic naming/structure, reuse boundaries, and spec alignment.
  Use when the user says "review this", "code review", "check my changes", "/code-review",
  or before staging non-trivial work. Report-only — never auto-fixes.
---

Report-only review. Never edit files, never auto-fix — this skill finds problems, it
doesn't solve them. Follows CLAUDE.md's own code rules while doing so: terse, no
restating comments, no fluff in the report.

## Scope

Default: `git diff --cached` (staged changes). If nothing is staged, fall back to
`git diff` (working tree) and say so. If the user names specific files or a commit
range, review that instead.

Read each changed file in full (not just the diff hunk) when a check needs
surrounding context — e.g. counting a file's total lines, or checking whether a
renamed identifier's other uses were updated.

## Checks

**1. CLAUDE.md settled decisions** — Playwright not Cypress, `page.ariaSnapshot({ boxes: true })`
not raw HTML/legacy accessibility API, Fastify+Zod, charter-scripted explorer (no
LLM-driven navigation), `TARGET_*` env vars only. Flag anything that relitigates or
silently drifts from these.

**2. CLAUDE.md code rules:**
- Comments explain WHY only (spec refs, bug rationale, non-obvious gotchas). Any
  comment that just restates what the next line does — flag it.
- Full-word identifiers; `id`/`url`/`db` and other established domain terms are fine,
  invented abbreviations (`req`, `ctx`, `doc`, `attrs`, ...) aren't. Cross-reference
  `unicorn/prevent-abbreviations` output where the file is lintable; call out the rest
  by eye (JSX, config files, anything outside `**/*.ts`/`**/*.tsx`).
- Max 4 function params (options object beyond that), max 250 lines/file, max 150
  chars/line. Cross-reference `max-params`/`max-lines`/`max-len` where lintable.

**3. Target-agnostic** — this is the class `.leakcheck` can't catch (that's a literal
string blocklist). Look for:
- Structural assumptions stated as fact about "the" target: a specific route shape,
  nav pattern, locale count, or field name presented as universal rather than
  per-target config. (Real example from this repo's history: engine-spec once locked
  a URL shape as "confirmed" — it was one target's shape, not a rule.)
- Literal app/host/route names that would've been caught by `.leakcheck` if
  committed — check anyway, since `.leakcheck` only runs at commit time on staged
  files, and a review can happen before staging.

**4. Reuse boundaries** — no forked types. If a new type/interface duplicates the
shape of an existing one elsewhere (`ActionDescriptor`-style intentional duplicates
excepted, and only when the code's own comment explains why it's not a shared import),
flag it. Check for the inverse too: an import that creates an unintended circular or
wrong-direction package dependency (e.g. `driver` importing `backend`).

**5. Tests** — live in `__tests__/` folders, never inline `src/*.test.ts`. New
behavior without a corresponding test is a blocker, not a style note.

**6. Node/TS hygiene** — no floating promises (every `await`ed, `.catch()`ed, or
intentionally fire-and-forget with a comment saying so), strict TS (no `any`), all IO
awaited.

**7. Spec alignment** — new behavior that isn't covered by an approved spec
(`docs/*.md`) is worth flagging, not necessarily blocking — CLAUDE.md's own rule is
"don't re-derive a locked spec's design," not "never write anything spec-less." Flag
it as a question, not an automatic blocker, unless it contradicts a locked spec's
explicit design.

## Output

Call `ReportFindings` once, findings ranked most-severe first (empty array if the
diff is clean). Map severity into the `category` field: prefix with `blocker-` for
build-breaking/regression/missing-test-for-new-behavior findings, `style-` for
naming/comment/formatting/length findings. Every finding needs a concrete
`failure_scenario` — not "this could be clearer" but the actual input/state that
breaks, or, for style findings, the specific rule violated and where.

Do not also print the findings as prose — `ReportFindings` is the output.
