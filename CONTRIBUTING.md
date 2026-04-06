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

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Run `pnpm test` and `pnpm run typecheck`
4. Submit PR with clear description

## License

MIT
