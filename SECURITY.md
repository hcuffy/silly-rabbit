# Security Policy

## Supported versions

This is a solo-maintained, pre-1.0-in-spirit open-source project with no LTS or backport
branches. Security fixes land on `main` only — there is no older release line that gets
patches. Run the latest `main` if you want fixes.

## Reporting a vulnerability

Please use [GitHub Security Advisories](https://github.com/hcuffy/silly-rabbit/security/advisories/new)
("Report a vulnerability" on the repo's Security tab) rather than a public issue. This
gives us a private channel to discuss and fix before disclosure.

> Private vulnerability reporting is not yet enabled on this repo as of this writing —
> that's a repo-settings toggle for the maintainer to flip, not something a reporter can
> control. Until it's on, email is the fallback: open a regular GitHub issue asking for a
> contact channel, or check the repo owner's GitHub profile for a public contact.

## Data handling — self-hosted, no data collection

Silly Rabbit is a self-hosted tool. There is no hosted service, no managed backend, and no
data Silly Rabbit's own code sends anywhere except what you explicitly configure:

- **Target app data** (screenshots, accessibility-tree snapshots, console/network
  evidence) is written to your own MongoDB instance and your own local filesystem
  (`screenshots/`, `repro-specs/`). Nothing leaves your infrastructure.
- **Target app credentials** (`TARGET_EMAIL`/`TARGET_PASSWORD` etc., or a captured
  `storageState` file) stay in your own `.env` and local `.silly-rabbit/` directory —
  gitignored, never transmitted anywhere except to the target app itself during login.
- **The only outbound network calls this codebase makes**, confirmed by reading the
  actual dependency graph and every `fetch`/HTTP call site, not assumed:
  1. The Anthropic API — only when `ANTHROPIC_API_KEY` is set and a judge call actually
     fires (a real state-divergence needing a verdict). No key, no call — the
     deterministic checks and structural diffing work with zero network calls.
  2. Your own MongoDB instance (`MONGO_URI`).
  3. The target app you point Silly Rabbit at (`TARGET_BASE_URL`).
  4. The dashboard frontend talking to its own backend (`VITE_API_BASE_URL`, defaults to
     `localhost`).

  Nothing else. No hosted analytics, no error-reporting service, no license-check
  ping, no phone-home of any kind.

## No telemetry

Confirmed, not assumed — a real pass across the whole dependency tree and every process
entrypoint (`cli.ts`, `server.ts`, `mcpServer.ts`, `recordSession.ts`) found:

- Zero analytics/telemetry SDKs (Mixpanel, Segment, Amplitude, PostHog, Sentry, Datadog,
  etc.) in any of the 6 packages' dependencies.
- Zero update-check or anonymous-usage-ping logic anywhere in the codebase.
- Zero unexpected outbound calls in application source — exactly one `fetch()` call
  exists in the whole codebase, and it's the dashboard frontend calling its own backend.
- Playwright's own bundled code was checked directly (source, not docs) given its
  tooling has a track record worth verifying rather than assuming — the only
  "telemetry" string found is Playwright *disabling* Firefox's own built-in telemetry
  via launch preferences, not Playwright reporting anything of its own.
- The Anthropic SDK's own "telemetry" references are `x-stainless-helper` identification
  headers attached to the same, already-disclosed API call — not a separate channel to
  a different destination.

If a future dependency bump ever introduces telemetry, that's a bug against this
document — open an issue.

## Prior security work

This codebase has been through several internal audit passes over its development,
stated plainly as history, not a compliance claim: a live-run audit of the explorer
mode (D8), a dedicated session-replay security/bug audit (4 real gaps found and fixed),
an MCP-server security + CRUD-completeness audit (found and fixed a real
resource-exhaustion gap), and a delete/cancel-capability audit (found and fixed a
double-submit and a zombie-orphan race). None of this substitutes for independent
review — it's just an honest account of what's already been looked at.
