# @blockrun/llm (TypeScript SDK)

TypeScript SDK for <!-- br:models.chatVisible -->82<!-- /br:models.chatVisible --> LLMs with streaming, smart routing, and pay-per-request billing.
Two authentication modes, one API surface:

- **Account API key** — `apiKey` / `BLOCKRUN_API_KEY` bills a BlockRun account at `https://api.blockrun.ai`. Register, mint keys and top up credits at https://user.blockrun.ai.
- **Wallet (x402)** — a wallet signature is the authentication; each request settles USDC on Base, Arc (`apiUrl: https://arc.blockrun.ai/api`, same `LLMClient` and key) or Solana. No account needed. The EVM domain signed follows the 402's `network` through `EVM_NETWORKS` in `src/x402.ts`; the 402's `extra` is never trusted for it.

## Commands

```bash
npm install              # install dependencies
npm run build            # compile with tsup (CJS + ESM + DTS)
npm run dev              # watch mode
npm test                 # run vitest
npm run typecheck        # type checking
npm run lint             # eslint
```

## Project structure

```
src/
├── index.ts             # Package exports
├── client.ts            # LLMClient (EVM: Base, Arc — the 402's network picks the chain)
├── solana-client.ts     # SolanaLLMClient
├── solana-batch.ts      # Opt-in x402 batch-settlement (metered) payer for SolanaLLMClient
├── router-adapter.ts    # Bundled Router Core V3 adapter (smartChat / blockrun/* aliases)
├── api-key.ts           # Account API-key auth: resolveApiKeyAuth / ApiKeyAuth transport + poll
├── blockrun.ts          # BlockrunClient — universal x402 primitive (get/post/poll/stream)
├── image.ts             # ImageClient — image generation + editing (multi-image fusion)
├── video.ts             # VideoClient — video generation (incl. realFaceAssetId)
├── portrait.ts          # PortraitClient — Virtual Portrait enrollment (ta_xxxxxx)
├── music.ts             # MusicClient — music/audio generation
├── speech.ts            # SpeechClient — TTS + sound effects (BlockRun Voice / ElevenLabs)
├── voice.ts             # VoiceClient — AI outbound phone calls
├── phone.ts             # PhoneClient — phone lookup + number provisioning
├── search.ts            # SearchClient — Grok Live Search
├── price.ts             # PriceClient — Pyth market data
├── surf.ts              # SurfClient — /v1/surf/* crypto data catalog
├── rpc.ts               # RpcClient — multi-chain JSON-RPC (Tatum, 40+ chains)
├── solana-deps.ts       # Lazy loader for the optional Solana peer deps
├── version.ts           # Single source of SDK_VERSION / USER_AGENT
├── wallet.ts            # EVM wallet management
├── solana-wallet.ts     # Solana wallet management
├── x402.ts              # x402 payment protocol
├── types.ts             # Type definitions
├── validation.ts        # Input validation
├── cache.ts             # Response caching
├── cost-log.ts          # Cost logging
├── setup.ts             # First-run setup (setupAgentClient / setupAgentWallet / setupAgentSolanaWallet)
├── anthropic-compat.ts  # Anthropic SDK compatibility layer
└── openai-compat.ts     # OpenAI SDK compatibility layer
```

## Key dependencies

- `@blockrun/router-core` — bundled, product-neutral smart model routing
- `@blockrun/core` — Shared kernel; owns Base wallet resolution, discovery, and adoption
  so this SDK, the `blockrun` CLI, and clawrouter-codex read the same wallet
- `viem` — Ethereum interaction
- `bs58` — Base58 encoding (Solana)
- Optional: `@anthropic-ai/sdk`, `@solana/web3.js`, `@solana/spl-token`

## Smart routing (smartChat / router-core)

- `smartChat()`, `smartChatCompletion()`, `route()`, and the `blockrun/auto|eco|premium` model aliases call the bundled Router Core V3 adapter (`src/router-adapter.ts`) on both chain clients. The aliases are NOT resolved by the Anthropic-compat layer (it proxies straight to `/v1/messages`).
- **Candidate policy (do not re-break — v3.11.0's 291668d and PR #25's review both litigated this):** the router's ranking is trusted as-is, including ids withheld from `/v1/models` (e.g. `moonshot/kimi-k2.7` — gateway serves them by direct id). The one exception is the `free/<model>` proxy namespace: map to the catalog-listed `nvidia/<model>` id, drop when there is no mapping. Strict `modelPricing.has()` filtering silently converts eco from $0 to paid and swaps premium's picks.
- Transient fallback (shared `isTransientError` in router-adapter.ts): timeout / network / 429 / 502 / 503 / 504 / 522 / 524, and ONLY for an error whose `RetryDisposition` is `"unpaid"` (`retryDisposition()` in types.ts; untagged = paid-or-in-doubt = never transient). The request layers tag at the source: `sendUnpaid()` / the 402 challenge / signing are `"unpaid"`; anything after the signed payment is sent (exact, batch, EVM, a 2xx body that will not parse) is `"paid-or-in-doubt"`; account mode follows `accountErrorDisposition()` (explicit 4xx unpaid, else in doubt: the POST itself is billed). Both clients walk the chain and log each hop to stderr. Caller-supplied `fallbackModels` beats the routed chain. A new throw site in a paid path MUST tag its error.
- The routing runtime and types are **derived directly from `@blockrun/router-core`**, pinned to an immutable GitHub commit. Do not hand-edit the upstream shapes; re-pin the reviewed router-core commit and rerun golden tests.
- `tsup.config.ts` holds the build config; its `dts.resolve` inlines the router-core declarations into the shipped `.d.ts`. After any routing-dependency bump, verify `grep -c router-core dist/index.d.ts` prints `0` — a leaked `import from '@blockrun/router-core'` is unresolvable in consumer trees. The full procedure is in CONTRIBUTING.md.

## Account API keys (`src/api-key.ts`)

- Every client option bag extends `ApiKeyOptions`. `resolveApiKeyAuth()` runs first in each
  constructor: an explicit `apiKey` wins over the environment, an explicit `privateKey` forces
  wallet mode even when `BLOCKRUN_API_KEY` is set, and passing both explicitly throws. With
  neither explicit, `BLOCKRUN_API_KEY` beats the wallet env vars — a process holding both
  runs in account mode.
- `ApiKeyAuth` is the shared transport: it pins the credential to the configured origin
  (`resolveUrl` refuses cross-origin, credentialed, and off-port URLs, including poll URLs),
  sets `redirect: "error"`, strips caller `*payment*` / `x-api-key` headers, and redacts the
  key out of error bodies. Base URL defaults to `https://api.blockrun.ai`, overridable with
  `apiUrl` (`baseURL` on `OpenAI`) or `BLOCKRUN_API_BASE_URL`; a trailing `/v1` is trimmed.
- **An account error never falls back to a wallet.** `fetch()` raises on any non-2xx, so the
  x402 signing path is unreachable in account mode; `APIError` carries `statusCode`, the
  account `code`/`type`/`message`, and `retryAfter`.
- Async jobs (image / video / music / `BlockrunClient.poll`) follow `poll_url` from the first
  authenticated response via `ApiKeyAuth.poll()` — no 402 challenge, no second POST.
- **Transient retries are GET/HEAD-only.** 502/503/504/522/524 retry twice on idempotent
  requests; a POST is never replayed, because in account mode the first POST is the billed
  one (the wallet path can retry because its first POST is the unpaid 402 challenge).
  `poll()` rides out a transient error to the deadline instead of dropping a paid job.
- Wallet-only surfaces throw `requireWallet()` in account mode: `getWalletAddress()`,
  `getBalance()`, and `getSpending()` (account usage lives in the dashboard, not in-process).
- `setupAgentClient()` picks account mode when a key is configured, otherwise honours a saved
  `~/.blockrun/payment-chain` preference, keeps Base-only installs on Base, and defaults new
  wallets to Solana. `setupAgentWallet()` / `setupAgentSolanaWallet()` stay chain-specific.

## Solana batch-settlement (`src/solana-batch.ts`)

- Opt-in via `SolanaLLMClient({ batch: { operators, maxDeposit } })`; drives the official
  `@x402/svm` 2.28 `BatchSvmScheme` (server-signed/operator mode) through `@x402/core`'s
  `x402HTTPClient`. Peers are optional and lazily imported; tsup keeps them external.
- **Trust is the caller's:** batch is off unless the caller lists an operator. BlockRun's key is
  exported as `BLOCKRUN_SOL_OPERATOR` (5YKPQUFj…1vm3, production, both channel roles) but is
  never applied by default, and the 402's `extra.operator` is never trusted. Server-signed channels
  only: `withoutClientSignedBatch()` strips client-signed batch accepts (`voucherSigner` omitted or
  `"client"`) before the scheme sees a 402 (its selection and its untrusted-operator fallback to a
  client-signed twin), and only-client-signed → `client_signed_not_supported` → exact. Legacy
  client-signed records (opened by earlier versions) stay refundable: `refundTarget()` takes the
  challenge's client-signed accept whose `channelKeyOf` names a stored client-signed record, when the
  trusted server-signed accept has no record (signer modes must match). `maxDeposit` bounds
  the unsettled escrow (deposit − on-chain settled): what the operator could claim beyond what is
  settled. Upstream caps lifetime deposits, so `prepareTopUp` reads `settled` before a top-up and
  `capOutstandingEscrow` widens the scheme's cap by it (top-ups of that channel only; a failed
  read keeps the lifetime cap). Deposit size: 402 `extra.minDeposit` if ≥ ceiling, else 5×,
  capped by the room.
- **One choke point, never double-pays.** `sendOnce()` is the only caller of `send()` for a batch
  payment and `classify()` the only interpreter of its answer: `charged` (any 2xx on a first send;
  on a replay only a 2xx with `success: true`), `not_charged` (FIRST send only: a 402 or a
  `BATCH_REFUSALS` code — closed list — with no receipt or a clean failed one, or a 429 whose receipt
  passes `provesNothingBroadcast` = the three facilitator reasons), or `in_doubt` (everything else:
  any exception once the send started whatever its `cause.code`, 5xx/unknown 4xx, a receipt with a
  transaction / `settlement_pending` / success on non-2xx, a 429 with any other receipt, ANY replay
  answer short of a success receipt — a 402 or `duplicate_settlement` on a replay means the original
  reached the gateway). Pre-send problems fall back to `exact`; not_charged → `exact`, or after a
  not-broadcast 429 backoff + `rechallenge` (fresh 402, never a stale blockhash) + a NEW payment, `exact`
  when `rateLimit` runs out. The rechallenge is the request itself, unpaid (`Rechallenge`): 402 → go on;
  2xx → `served` (the call's result, nothing paid; `recovered` / `served_unpaid_on_rechallenge`);
  anything else or no answer → `failed`, its error raised `"unpaid"`. NEVER exact against the stale 402.
  in_doubt ends only in `resolveInDoubt()` — a receipt-less 429 gets ONE byte-identical replay after
  its backoff (owner policy) — or `raiseUnresolved()` →
  `BatchPaymentUnresolvedError` (`PaymentError`, disposition `paid-or-in-doubt`; reason
  `replay_unresolved | ambiguous_rate_limit | no_response | outcome_unknown`; wallet, requestId,
  channelId, payloadKind, depositInDoubt, status, cause) + `unresolved` event/log/counter. NEVER a new
  authorization, new deposit, exact or fallback model for a call in doubt; NEVER chain state or the
  402's `lastValidBlockHeight` to clear charge doubt (the old `neverCompletes` open-replacement proof is
  gone on purpose). `payWith()`'s catch turns any unexpected error after a send into the same raise.
  Future gateway evidence (receipts on every response, a fenced request-status endpoint) plugs into
  `resolveInDoubt()`.
- **Never silent:** every fallback/backoff/recovery/resync/unresolved goes through `report()` — one
  stderr line (`[@blockrun/llm] batch-settlement event=... reason=...`, never deduplicated), the
  client's counters (`getBatchStats()`: ..., `unresolved`, `unresolvedByReason`), and `batch.onEvent`.
  Reasons are stable codes, not messages.
- State is per WALLET, not per client, and per PROCESS, not per module copy: `WalletBatch`es and held
  locks live in the `globalThis[Symbol.for("@blockrun/llm/batch-registry/v1")]` registry (bump the
  version when `WalletBatch` changes shape), so CJS + ESM copies share one scheme + in-flight flag.
  The channel-file lock holds the bare pid ONLY (3.19.x reads it with `Number(raw.trim())`; any other
  format reads `NaN` to them = stale, so they would steal a live lock); the ownership token lives in the
  `<lock>.owner` sidecar, and a release needs both to match. A lock naming this pid that the registry
  does not hold is NEVER stale (another SDK copy). Match errors from the shared book by `name`, not `instanceof`. One
  batch request in flight per wallet; concurrent calls pay `exact`, they do not queue (they only wait
  out a 429 cooldown). `parseRetryAfter` drops a non-finite or > 1 day value (default backoff);
  `coolDown()` caps `wallet.cooldownUntil` at now + `maxWaitMs`, while the call itself weighs the full
  delay (over its remaining budget → exact / raise at once).
- **Deposits in doubt (P2) are settled at `finalized` only.** Any pending `wallet.resyncs` target
  blocks every batch payment for the wallet (`resync()` throws `ResyncError` → exact), so no second
  deposit is signed over one in doubt. `readChannelAccount` reads at `finalized` (+ `minContextSlot`).
  Adopt when the finalized channel holds `max(expectDeposit, knownDeposit)` (`distrust()` takes
  `sent.expectDeposit`, the pre-send value journaled; never recompute it from a record the scheme may
  already have committed, e.g. a success receipt on a non-2xx); "never landed" only when
  `getEpochInfo(finalized).blockHeight > anchorHeight + LANDING_MARGIN_BLOCKS` (300) and a read with
  `minContextSlot` at that slot still lacks it (open → record dropped, top-up → rewritten from chain).
  `anchorHeight` is the SDK's own `getBlockHeight(confirmed)` taken after the payment was built (lazily
  on the first short read) — never wall clock, never the 402. `prepareTopUp` reads `settled` at
  finalized and refuses (exact + `deposit_unrecorded` re-read) when the chain holds more deposit than
  the record; a closing/closed or not-ours channel (payer, operator, mint) queues a `channel_unusable`
  target and throws `ChannelResyncRequiredError`, so `createPayload()` re-reads at once (closed →
  record dropped → fresh open; foreign → `channel_unreadable`, exact): never a deposit into it. Only `value: null` is absent; any other undecodable account throws
  `ChannelUnreadableError` → `channel_unreadable` (record kept, exact).
- **Crash safety.** With the file store, `journalDeposit()` writes a `DepositIntent` to
  `FileIntentJournal` (`<store>.deposit-intents` = full store path + suffix, one per store; never a name
  ending `.json`, so it never collides with `legacyBeside()`, the old stripped-`.json` name two stores
  could share, whose intents `adoptLegacy()` moves on wallet load BY PAYER, fail-closed on an unreadable
  file; temp + fsync + rename + dir fsync) BEFORE the
  deposit is sent (journal failure → not sent, `deposit_journal_failed`, exact); `forgetIntent()` only
  after reconciliation (definitive receipt, not_charged, or a finalized re-read). On wallet load every
  intent becomes a resync target (`orphaned_deposit`); nothing is ever re-sent from it. Only ENOENT is
  an empty journal: unparseable, `version !== 1`, non-object `intents` or a malformed intent
  (`intentProblem`) throws → `deposit_journal_unreadable` (batch off for the wallet). An intent can
  outlive its reconciled receipt (crash or failed `remove` after the scheme saved), so `resync()` writes
  `max(target.cumulative, settled, stored record's confirmed cumulative)`: never move it backwards.
  `ChannelBook.set()` updates `seen` only AFTER `base.set()` succeeds, so a failed save of a
  reconciled receipt leaves the pre-send cumulative for `distrust()` to add the charge to once.
  `channelStore: false` → `MemoryIntentJournal`: no crash recovery (documented; do not claim it).
- **Never forget a funded channel.** Only a successful close `forget()`s, and only the closed channel's
  key (its record and scheme memory; the file goes once empty). `close()` throws
  `BatchCloseDeferredError` (`call_in_flight` while `wallet.busy || wallet.active > 0`; a call still
  awaiting its 402 is not in `pay()` yet, so `requestWithPayment` takes `closeFence()` (the wallet's
  `closes` count) before its first POST and `pay()` falls back `closed_during_call` if a close completed since;
  `deposit_in_doubt` while any target with `expectDeposit` stays pending after a re-read). It probes the
  refund 402 itself and takes its trusted server-signed accept; `prepareClose()` re-reads, rebuilds the
  scheme and loads only that accept's `channelKeyOf` record (private `loadChannel`), because upstream's
  refund never reads a stored server-signed record (otherwise needs a gPA scan) and falls back to the
  first cached channel by receiver+asset, whatever its operator. The refund then runs with that accept
  as `requirements`, so upstream does not re-probe and pick another. The account decoder is checked
  against `@x402/svm`'s exported `CHANNEL_ACCOUNT_SIZE` / `CHANNEL_RENT_PAYER_OFFSET`:
  `readChannelAccount()` runs `checkChannelLayout()` before EVERY decode, and a `ChannelLayoutError`
  is `channel_unreadable` (record kept, exact) in `resync()` and in `prepareTopUp()` alike, and so is a
  `ChannelUnreadableError` in `prepareTopUp()`; only a transport/RPC failure there keeps the lifetime cap
  and continues. Fail closed: never size or sign a deposit from an unchecked or unreadable account.
- **Same RPC config as exact:** `rpcUrl` + resolved `rpcHeaders` (incl. `SOLANA_RPC_HEADERS` /
  `SOLANA_RPC_API_KEY`). `BatchSvmScheme` takes only `rpcUrl` and kit's transport calls global
  `fetch`, so `withRpcHeaders()` runs scheme calls in an AsyncLocalStorage scope and a
  global-`fetch` wrapper (installed only when headers exist) adds them to requests for exactly
  that URL inside the scope. The scope store and hook marker live on `globalThis` under
  versioned `Symbol.for` keys so two loaded copies (CJS + ESM) share one hook. Headers are part of the per-wallet config key.
- Only `requestWithPayment` (non-stream chat) uses it. Streams have no `PAYMENT-RESPONSE` to
  reconcile, and media jobs are charged on a later poll — keep both on `exact` unless the
  gateway contract changes.

## Supported chains

Only relevant in wallet mode; account API keys are chain-independent.

- Solana Mainnet — USDC SPL (recommended for new wallets)
- Base Mainnet — USDC
- Base Sepolia (testnet) — Testnet USDC

## Conventions

- TypeScript strict mode, ESM + CJS dual output
- Build with tsup
- Test with vitest
- Lint with eslint
- pnpm as package manager
- Node >= 20
- MIT license
- npm registry: `@blockrun/llm`
