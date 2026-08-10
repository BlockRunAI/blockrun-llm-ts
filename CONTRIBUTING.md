# Contributing to @blockrun/llm

## Setup

```bash
git clone https://github.com/BlockRunAI/blockrun-llm-ts
cd blockrun-llm-ts
pnpm install
pnpm run build
```

## Development

```bash
pnpm run dev             # Watch mode
pnpm test                # Unit tests (vitest)
pnpm run typecheck       # Type checking
pnpm run lint            # Linting
```

## Code Standards

- TypeScript strict mode
- ESM + CJS dual output via tsup
- pnpm as package manager
- Node >= 20

## Updating the routing engine (router-core)

The routing runtime and types derive directly from `@blockrun/router-core`, a
devDependency installed from an immutable GitHub commit tarball and inlined
into both the JavaScript bundle and shipped `.d.ts`.

```bash
# 1. Re-pin the reviewed router-core commit:
pnpm add -D "@blockrun/router-core@https://codeload.github.com/BlockRunAI/router-core/tar.gz/<commit>"

# 2. Rebuild and prove the bundles stayed self-contained
pnpm run build
grep -c router-core dist/index.d.ts   # MUST print 0

# 3. Pack + install into a clean project with no router-core dependency
npm pack

# 4. Run Core golden vectors plus full CI before pushing
pnpm run typecheck && pnpm run lint && pnpm test run && pnpm run build
```

If step 3 prints anything but `0`, the shipped `.d.ts` imports a package
consumers cannot install and every routing type degrades to `any` downstream.

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Run `pnpm test` and `pnpm run typecheck`
4. Submit PR with clear description

## License

MIT
