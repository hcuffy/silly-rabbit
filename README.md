# Silly Rabbit

Open-source AI agent that drives a web app's UI via [Playwright](https://playwright.dev) to find issues, remembers prior runs so each run suppresses known noise and surfaces only what changed, and reports verdicts through an LLM judge rather than raw diffing. "CodeRabbit for UI."

All-TypeScript/Node monorepo (pnpm workspaces).

## How it works

Three ways to point it at a UI:

1. **Charter-scripted** — a plain-language charter (e.g. "test the locations flow") drives a fixed navigate-and-observe loop against a target screen. Findings are diffed against a remembered baseline; only new or changed states surface as a `Finding`.
2. **Feature-description-driven explorer** — point it at a named feature/section with a short description of what it does. It researches the section's UI inventory (inputs, buttons, entity fields), generates hypothesis-driven happy-path and boundary/adversarial test cases, executes them against the real UI (with marker-based rollback for anything it creates), and persists what it learns per feature so a later run doesn't re-flag behavior a human already confirmed as intended.
3. **Session-derived replay** — record a real walkthrough once (`record-session`, a CLI command driving a real browser), then replay it anytime from the dashboard. No charter or feature description needed; replays run either against the live target or against the exact responses captured at recording time.

All three modes route every verdict through the same LLM judge (`claude-sonnet-4-6` by default, escalating to `claude-opus-4-8` on low confidence) and the same safety floor, and all show up in the same run history and dashboard.

## Safety floor

- **Domain allowlist** — refuses to navigate anywhere not explicitly allowed.
- **Production-URL refusal** — a second, heuristic layer of defense in depth on top of the allowlist.
- **Destructive-action guard** — refuses to click anything that looks like Delete/Pay/Confirm/Purchase, with one narrowly scoped, explicitly signed-off exception: the explorer's own rollback step may delete only the row it just created, and only after verifying the match by marker.
- **Budget enforcement** — a step cap, an LLM-call cap, and a hard USD-per-run cost cap.
- All of it hard-fails the run with a stated reason in `Run.error` — nothing silently proceeds past a tripped guard.

## Current state — v1.0.0

Both exploration modes are built and code-complete, including the safety floor and a dashboard to trigger runs and review results. The feature-description explorer has been run live against a real target end to end — real login, real research, real hypothesis execution, real findings persisted and reviewable, real rollback of what it created. Both modes share the same target-login setup (below).

**Dashboard access control landed** — single-password login now gates every route on Silly Rabbit's own backend (previously: none at all, anyone reaching the backend's URL could trigger runs, read findings, or dismiss them). See "Dashboard access" below. Still a personal-tool default, not battle-tested beyond localhost.

**Dashboard analytics** — findings show a new-vs-suppressed count, a judge-escalation badge (Sonnet vs Opus), and a judge-accuracy score (how often a human agreed with the judge's verdict) — each shown both for the current run and as an all-time total for that target.

**Screenshots** — every finding captures a screenshot; local storage is capped by total size, oldest deleted first once the cap is hit (`SCREENSHOT_STORAGE_CAP_MB`, see `.env.example`).

**Hosting** — not deployed anywhere yet. Env-driven groundwork is in place (`TRUST_PROXY`, `COOKIE_SECURE`, `COOKIE_SAME_SITE`, all default to safe localhost behavior) — see `MILESTONES.md`'s Hosting checklist for the actual flip-list once there's a real URL to point at.

Honest gaps: two validation items are still open — confirming target-shape assumptions (literal ID format in URLs, query-parameter handling) against a real target hasn't been closed yet. (A third, locale-specific relative-time masking, has since been confirmed and fixed.) This is a young project; expect rough edges.

## Quickstart

```bash
git clone git@github.com:hcuffy/silly-rabbit.git && cd silly-rabbit
cp .env.example .env
pnpm install
pnpm db:up          # Mongo, via Docker Compose v2 (docker compose up -d also works)
```

That's the whole prerequisite for both paths below. Dev-hygiene commands (typecheck/lint/test) are in [`CONTRIBUTING.md`](./CONTRIBUTING.md), not required just to run Silly Rabbit.

## Try it now (zero-config)

No target app, no API key, no more `.env` edits — this drives a bundled fake target via Playwright route interception (no real network call), so it works immediately after the Quickstart above.

```bash
# 1. Learn a baseline against the demo target
pnpm --filter driver explore --charter "test the locations flow" --run demo-1
```

```bash
# 2. Same charter, a deliberately changed variant — detects a real regression
pnpm --filter driver explore --charter "test the locations flow" --run demo-2 --variant changed-regression
```

Run 1 prints `"newBaselines": 1, "findings": []` — it just learned what the screen looks like. Run 2 prints a `STATE_DIVERGENCE` finding — a real structural change, correctly detected. Without `ANTHROPIC_API_KEY` set, its `verdict` shows `NEEDS_HUMAN` with a plain "judge unavailable, set ANTHROPIC_API_KEY to enable full judging" reason instead of a reasoned verdict — that's the deterministic-only fallback working as intended, not a broken run. Set `ANTHROPIC_API_KEY` in `.env` to get a real reasoned verdict on divergences like this one.

`pnpm --filter driver explore --help` shows the full option list and both commands above.

## Configure your real target

Once the zero-config demo above works, this is the next step — pointing Silly Rabbit at your own app and gating your own dashboard. Two things, independent of each other:

### Dashboard access (Silly Rabbit's own backend)

Separate from the target-app credentials below, which authenticate the agent *into the app it's testing*, not into Silly Rabbit itself.

```
DASHBOARD_PASSWORD=<a real password, yours to pick>
```

Required, no default — the backend refuses to start without it. `SESSION_SECRET` is optional: if unset, a real random secret is generated once and persisted to `.silly-rabbit/session-secret` (gitignored) so it survives restarts; set it explicitly in `.env` only if you want to control/rotate it yourself. Signed httpOnly session cookie, one global route gate. `COOKIE_SECURE`, `COOKIE_SAME_SITE`, and `TRUST_PROXY` all default to safe localhost values (`false`/`lax`/`false`) and only matter once this is ever hosted somewhere beyond localhost.

### Target login (the app under test)

How the agent authenticates *into the app it's testing*. Applies to both exploration modes. Two options — auto-login is preferred (session never stale); storageState is the fallback. Also set `ALLOWED_DOMAINS` (comma-separated hostnames) to your target's host — leaving it empty starts the backend fine but fails every real-target run's first safety check; the backend logs a warning at startup naming this exact consequence if you forget.

#### Option A — Auto-login (preferred)

Set all six vars in `.env`; the backend logs in fresh before every run:

```
TARGET_LOGIN_URL=https://your-dev-env.example.com/login
TARGET_EMAIL=test-account@example.com
TARGET_PASSWORD=...
TARGET_EMAIL_SELECTOR=[data-cy-id="email"]
TARGET_PASSWORD_SELECTOR=[data-cy-id="password"]
TARGET_SUBMIT_SELECTOR=[data-cy-id="submit"]
```

**Guardrails:** use a low-privilege throwaway account on an isolated sandbox only. Never a real or shared account. The password never appears in logs or run records.

If login fails (wrong credentials, captcha, 2FA), the run is marked `FAILED` with a clear reason and no unauthenticated page is captured. For captcha / 2FA, fall back to Option B.

#### Option B — Storage state (fallback)

Capture a session once with Playwright codegen, then point the backend at it.

**1. Capture — run from repo root:**

```bash
npx playwright codegen \
  --save-storage="$(pwd)/.silly-rabbit/auth.json" \
  https://your-dev-env.example.com
```

Log in through the browser that opens. Close it; Playwright writes the session to `.silly-rabbit/auth.json` (gitignored).

**2. Set in `.env`** (absolute path — relative paths break when backend cwd differs):

```
STORAGE_STATE_PATH=/absolute/path/to/.silly-rabbit/auth.json
```

**3. Restart the backend.** If the file is absent or the var is unset, runs proceed unauthenticated. Auto-login takes precedence when all six `TARGET_*` vars are set.

## License
MIT — see [LICENSE](./LICENSE).
