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

## Updating the routing engine (ClawRouter / router-core)

`smartChat()`'s routing types derive from `@blockrun/router-core`, a
devDependency installed from a GitHub commit tarball (router-core is not on
npm) and inlined into the shipped `.d.ts` by `tsup.config.ts`'s `dts.resolve`.
The pinned commit must match what the ClawRouter release bundles, so a
ClawRouter bump is a two-package move:

```bash
# 1. Bump the router
pnpm add -D @blockrun/clawrouter@latest

# 2. Read the router-core commit the new ClawRouter pins…
npm view @blockrun/clawrouter@latest # or check its repo's package.json
#    …and re-pin our devDependency to the same commit:
pnpm add -D "@blockrun/router-core@https://codeload.github.com/BlockRunAI/router-core/tar.gz/<commit>"

# 3. Rebuild and prove the declarations stayed self-contained
pnpm run build
grep -c router-core dist/index.d.ts   # MUST print 0

# 4. The definitive consumer check: pack + install into a clean project
#    (no router-core, no clawrouter) and typecheck with skipLibCheck: false
npm pack

# 5. Full CI before pushing
pnpm run typecheck && pnpm run lint && pnpm test run && pnpm run build
```

If step 3 prints anything but `0`, the shipped `.d.ts` imports a package
consumers cannot install and every routing type degrades to `any` downstream.
Also update the routing peer floor in `package.json` if the new ClawRouter
changed routing behavior consumers depend on.

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Run `pnpm test` and `pnpm run typecheck`
4. Submit PR with clear description

## License

MIT
