# Contributing

Read [`CLAUDE.md`](./CLAUDE.md) and [`Silly-Rabbit-Build-Plan.md`](./Silly-Rabbit-Build-Plan.md) before sending a PR — they hold the settled architecture decisions and the deliverable order. Work one deliverable at a time; don't skip ahead.

## Local commands

Run `corepack enable` once per machine first — `package.json`'s `packageManager` field pins an exact pnpm version (currently `10.34.1`); corepack reads that field and transparently uses the matching pnpm release, so your local pnpm always matches the one this lockfile was generated with. Node version is pinned in `.nvmrc` (`nvm use`) and enforced at install time (`engine-strict=true` in `.npmrc` — `pnpm install` fails loud, not silently, on a mismatched Node).

```bash
pnpm install
pnpm -r typecheck     # strict TS across every package
pnpm lint              # ESLint, flat config, type-aware rules
pnpm -r test           # Vitest per package
pnpm format            # Prettier write
```

## Conventions

- Strict TypeScript, no `any`, no floating promises.
- Shared `Finding`/`Run`/`AppMap`/`Baseline` Zod schemas in `packages/shared` are the single source of truth — don't fork these shapes in other packages.
- Cheapest oracle first: don't add an LLM call where a deterministic check works.
- Mask non-determinism (timestamps, random ids, animations, locale strings) before fingerprinting.
