# Developer wiki — folder/file glossary

Lookup dictionary, not a tutorial. Confirmed against the real repo tree at time of
writing — grep it again before trusting this if it's been a while, packages grow fast.

Package dependency direction, most-dependent first: `backend` depends on `explorer`,
`explorer` depends on `driver`, `driver` depends on `engine`, `engine` depends on
`shared`. `shared` depends on nothing else in this repo. `frontend` depends only on
`shared`. Nothing ever depends "backwards" against this chain (e.g. `driver` never
imports from `backend`).

---

## `packages/shared`

Zod schemas — the single source of truth for every data shape in the system,
shared by every other package (including `frontend`). Zero Mongo/Playwright
dependency by design, so it's safe for anything to depend on.

- `schemas/run.ts` — `Run`: one execution of either testing mode. Status, step/cost
  counters, timestamps.
- `schemas/finding.ts` — `Finding`: one flagged issue. Type, verdict, evidence,
  before/after screenshot paths, dedup key, triage status.
- `schemas/baseline.ts` — `Baseline`: the remembered "normal" state of one screen,
  captured the first time that screen is ever seen.
- `schemas/appMap.ts` — `AppMap`: the running list of every screen the scripted mode
  has discovered for a target.
- `schemas/researchInventory.ts` — `ResearchInventory`: what the explorer's research
  step found about one feature's UI — its elements and entity fields.
- `schemas/featureHypothesis.ts` — `FeatureHypothesis`/`Check`/`BoundaryCheck`: one
  test idea the explorer generated, and its happy-path/boundary check pair.
- `schemas/testRun.ts` — `TestRun`: one explorer run's full record — research, test
  plan, check outcomes, linked finding ids.
- `schemas/learning.ts` — `Learning`: one remembered human verdict about a feature,
  so the same question is never asked twice.
- `schemas/featureDocument.ts` — `FeatureDocument`: one generated write-up of a
  feature. Append-only — every generation is kept, never overwritten.
- `analytics/findingStats.ts` — pure reducer, new-vs-suppressed finding counts.
  Shared so frontend and backend never compute the number two different ways.
- `analytics/judgeAccuracy.ts` — pure reducer, how often a human agreed with the
  judge's verdict.
- `index.ts` — re-exports everything above; the only file other packages import
  `@silly-rabbit/shared` symbols from.

---

## `packages/engine`

The deterministic core: perceiving a page, fingerprinting its state, deciding what's
worth flagging, and the actual judge call. No Playwright, no Mongo — pure logic plus
one outbound call to Anthropic.

- `ariaTree.ts` — parses Playwright's raw aria-snapshot text into a real tree
  structure everything else can walk.
- `mask.ts` — strips non-deterministic content (timestamps, relative-time phrases,
  ID-shaped values) out of a snapshot before it's compared, so those don't cause
  false-positive divergences.
- `fingerprint.ts` — turns a masked snapshot into one short hash — the actual
  "did this screen change" comparison point.
- `screenId.ts` — decides what counts as "the same screen" across runs from a page's
  URL — handles hash-based routing, collapses a trailing numeric id so two different
  records under the same route still count as one screen.
- `oracle.ts` — the cheap, deterministic checks that need no AI call at all: console
  errors, failed network requests, an unexpectedly blank screen.
- `dedup.ts` — computes the identity key that recognizes "this is the same issue as
  last time," not a new one.
- `judge.ts` — the actual Claude call: judges whether a detected divergence is a
  real regression, with a second, more careful pass when the first isn't confident.
  Also holds the shared `AnthropicLike`/`AnthropicMessageResponse` client interface
  every AI-calling module in the repo mocks against, and the model-pricing table.
- `runner.ts` — the loop tying scripted-mode checking together: compare to baseline,
  run the oracle, call the judge when needed, decide new/recurring/resolved per
  finding.
- `types.ts` — shared internal type definitions used across the files above.
- `scripts/judge-eval.ts` — manual, one-off script for sanity-checking real judge
  output quality against a known scenario. Not part of the shipped product.

---

## `packages/driver`

The Playwright automation layer — everything that actually drives a real browser.
Also home to the CLI entry point and its own lightweight Mongo path.

- `login.ts` — logs into the target app with real keystrokes; handles apps that only
  reveal the password field after the email step.
- `navigationGuard.ts` — the technical enforcement behind "never leaves the allowed
  app" — intercepts every real navigation request the browser issues, not just the
  obvious link clicks.
- `capture.ts` — takes the actual "look at the screen" snapshot at any moment: aria
  tree, screenshot, and whatever console/network errors happened since the last look.
- `charter.ts` — turns a short plain-English instruction into a concrete navigation
  plan for scripted mode.
- `explore.ts` — runs a full scripted-check session end to end: log in, follow the
  charter, capture along the way.
- `reproSpec.ts` — writes a runnable test file reproducing exactly what a finding
  saw, so a human can re-run it standalone later.
- `triggeredBy.ts` — records which local user account actually kicked off a run.
- `runStore.ts` — the CLI's own lightweight Mongo-backed run record — separate code
  path from the backend's own repos, but writes to the same collection/shape so a
  CLI-triggered run still shows up in the dashboard.
- `pixelDiff.ts` — compares two screenshots pixel-by-pixel, returns a mismatch
  fraction.
- `cli.ts` — the command-line entry point for running a scripted check outside the
  dashboard.
- `cliSafety.ts` / `localStore.ts` / `types.ts` — CLI-specific mirrors of the safety
  checks and local (non-database) record-keeping the CLI needs standalone, since it
  has no backend process around it.
- `mock/pages.ts` / `mock/routes.ts` — a fake, in-memory target app used only by the
  test suite, so tests never depend on a real live app being reachable.

---

## `packages/explorer`

Everything specific to feature-description-driven exploratory testing (the
"D8" mode): locating a described feature, researching its UI, generating and
executing test ideas, remembering outcomes, and writing feature docs.

- `sectionLocate.ts` — given a feature description, finds and navigates to that part
  of the real app.
- `research.ts` / `researchClassify.ts` / `researchTable.ts` — look at a located
  feature's screen and build its "inventory" — form fields, buttons, what kind of
  record it manages.
- `researchMarkdown.ts` — renders that inventory as readable markdown.
- `testPlan.ts` — asks the AI to turn an inventory into concrete test ideas (a
  happy-path + boundary check pair per idea).
- `testPlanMarkdown.ts` — renders a generated test plan as readable markdown.
- `happyPathExecutor.ts` — actually performs a "does the normal use case work"
  check against the real browser and judges the result. Also defines the shared
  button-resolution/click-target logic `boundaryExecutor.ts` reuses.
- `boundaryExecutor.ts` — actually performs a "try to break it" check, including
  safely injecting a marked, identifiable test value when the check needs to create
  something.
- `marker.ts` — generates and recognizes those identifiable throwaway test values,
  so cleanup finds exactly what it created and nothing else.
- `rollback.ts` — the cleanup step: verifies a boundary check's test data was
  actually created, deletes it, confirms it's actually gone afterward.
- `outcomeJudge.ts` — the AI call specific to judging one check's pass/fail outcome
  (distinct from the scripted-mode judge in `engine`).
- `dedupSignature.ts` — computes the identity key for "is this the same
  check-failure as before," explorer's own flavor of `engine`'s dedup logic.
- `checkExecutionError.ts` — tells a genuine check failure apart from one that
  merely timed out, and builds the corresponding finding either way.
- `learningContext.ts` — loads what's already been confirmed about a feature before
  a run starts.
- `feedback.ts` — records a human's verdict on a finding after the fact, turning it
  into (or updating) a remembered `Learning`.
- `drift.ts` — flags when something previously marked "fine" starts failing again,
  or something previously flagged as broken starts passing.
- `usageTracking.ts` — tallies how many AI calls a run made and what they cost, by
  wrapping the client factory every AI-calling step already uses.
- `featureDocumentGenerator.ts` — the self-writing feature-doc capability: asks the
  AI to summarize a feature's inventory plus its remembered learnings into a
  plain-English write-up. Sonnet-only, plain text response, no tool-use — a
  deliberate departure from the judge's structured-verdict pattern, since generating
  a doc has no confidence score to gate an escalation on.
- `anthropicToolSchema.ts` — the shared type describing a structured tool-call
  request shape, reused wherever a call needs a structured (not free-text) answer.

---

## `packages/backend`

Fastify HTTP server + Mongo persistence + the orchestration that actually runs
either testing mode end to end and saves the result.

- `server.ts` — the real process entry point; reads all configuration from the
  environment and wires every dependency together.
- `app.ts` — defines every dashboard-facing route and wires each to its underlying
  logic. Also owns the global auth gate every route sits behind.
- `auth.ts` — the password check and signed session-cookie logic behind dashboard
  login.
- `safety.ts` — where the safety-floor rules live for the backend-orchestrated path:
  domain allowlist, production-URL refusal, destructive-action refusal.
- `orchestrator.ts` — runs a scripted check end to end for real: the backend's
  equivalent of `driver/explore.ts`, but for the persisted, dashboard-visible path.
- `explorerOrchestrator.ts` / `explorerRunLifecycle.ts` — the same, for an
  exploratory-testing run: research → test-plan → execute → persist, with real
  safety guards bound.
- `runArtifacts.ts` — after a run finishes, attaches repro files and screenshots
  (including a screen's very first "before" screenshot) to the right
  findings/baselines.
- `featureDocumentRoutes.ts` — the routes behind the self-writing feature-doc
  feature, including its per-feature regeneration cooldown.
- `screenshotRetention.ts` — keeps total saved-screenshot disk usage under a
  configured cap, deleting the oldest files first once it's exceeded.
- `db/connection.ts` — opens and closes the Mongo connection.
- `repos/*.ts` — one file per record type (`runRepo`, `findingRepo`, `baselineRepo`,
  `appMapRepo`, `testRunRepo`, `learningRepo`, `featureDocumentRepo`,
  `mongoDocument.ts`'s shared helper) — each is the only place that record type is
  actually read from or written to the database.
- `index.ts` — re-exports the backend pieces other tools (like the CLI) are allowed
  to reuse.
- `scripts/manual-mock-server.ts` — a standalone fake target app runnable by hand
  for manual testing, separate from the automated test suite's own fake target.

---

## `packages/frontend`

The React dashboard.

- `main.tsx` / `App.tsx` / `AppShell.tsx` — the app's real entry point, its
  login-gated routing, and its persistent outer frame (branding, always-visible
  shell around every page).
- `lib/apiClient.ts` — every actual network call to the backend, plus validating
  each response is shaped the way it's supposed to be.
- `lib/queries.ts` — wraps each of those calls for React — loading/error states,
  caching, automatic refetching.
- `lib/dateGrouping.ts` / `lib/formatDateTime.ts` — small display helpers: grouping
  runs by day, formatting dates/times readably.
- `lib/useTriageShortcuts.ts` — the keyboard-shortcut logic behind reviewing
  findings without touching the mouse.
- `views/HomePage.tsx` — the landing page: both "start a new run" forms plus run
  history.
- `views/NewRunForm.tsx` / `views/NewExplorerRunForm.tsx` — the two forms for
  kicking off a scripted check versus an exploratory test.
- `views/RunHistory.tsx` — the paginated, day-grouped list of past runs.
- `views/RunDetailPage.tsx` / `views/RunDetail.tsx` — one run's detail page — status,
  findings, and (for exploratory runs) its research/test-plan/feature-doc section.
- `views/LoginScreen.tsx` / `views/LoadingScreen.tsx` — the password gate and its
  loading state.
- `components/TestRunSection.tsx` — everything specific to an exploratory run's
  detail view: research summary, test plan, check outcomes, and the feature-doc
  generate/history UI.
- `components/FindingCard.tsx` — one finding's full display: verdict, reasoning,
  screenshot, before/after diff, pixel-diff score when available.
- `components/EvidenceDiff.tsx` — the actual before/after line-by-line diff render
  used inside a finding card.
- `components/RunId.tsx` / `components/StatusBadge.tsx` / `components/StatusIcon.tsx`
  — small reused display pieces: a copyable shortened run id, and a run's status
  shown as text or as a small icon.
