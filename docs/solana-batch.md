# Solana batch settlement

Reference for `SolanaLLMClient`'s opt-in batch settlement (metered billing).
The [README](https://github.com/BlockRunAI/blockrun-llm-ts#batch-settlement-optional-metered-billing)
has the short version; this page holds the full runtime contract.

- [Overview](#overview)
- [Enable it](#enable-it)
- [Trust and spending boundary](#trust-and-spending-boundary)
- [Runtime behavior](#runtime-behavior)
- [Payment identifier](#payment-identifier)
- [Trust model](#trust-model)
- [In doubt means raised, never paid again](#in-doubt-means-raised-never-paid-again)
- [Safe fallback](#safe-fallback)
- [Deposit size](#deposit-size)
- [429 means wait, not give up](#429-means-wait-not-give-up)
- [A deposit in doubt blocks new deposits](#a-deposit-in-doubt-blocks-new-deposits)
- [Events and stats](#events-and-stats)
- [Scope](#scope)
- [One channel per wallet](#one-channel-per-wallet)
- [State and crash safety](#state-and-crash-safety)
- [Closing](#closing)
- [RPC](#rpc)
- [A funded channel is never forgotten](#a-funded-channel-is-never-forgotten)
- [Rollout](#rollout)

## Overview

By default, every Solana call uses x402 `exact`: one SPL transfer per call,
priced at the request ceiling and settled before the model answers. Batch
settlement replaces those per-call transfers with a bounded payment channel.
The client locks a small deposit once, each request authorizes no more than its
quoted ceiling, and the gateway charges the metered cost after the response.

> **No operator key needs to be created, copied, or stored in an environment
> variable.** `BLOCKRUN_SOL_OPERATOR` is a public constant exported by this SDK.
> Adding it to `batch.operators` is the explicit opt-in: it tells the client that
> this wallet trusts BlockRun's operator to sign vouchers against the channel,
> up to `maxDeposit`.

Without a `batch` option, behavior is unchanged and every request uses `exact`.
If batch is unavailable or unsafe for a request, the SDK falls back to `exact`
before it sends a batch payment. Once one is sent, a call whose payment may have
been charged is raised as `BatchPaymentUnresolvedError`, never paid again (see
[Runtime behavior](#runtime-behavior)).

## Enable it

In addition to the Solana wallet dependencies (`@solana/web3.js`,
`@solana/spl-token`), batch mode needs three optional peer dependencies:

```bash
npm install @x402/core@~2.28.0 @x402/svm@~2.28.0 @solana/kit
```

```typescript
import { SolanaLLMClient, BLOCKRUN_SOL_OPERATOR } from '@blockrun/llm';

const client = new SolanaLLMClient({
  privateKey: process.env.SOLANA_WALLET_KEY,
  batch: {
    // Provided by @blockrun/llm. This explicit trust decision enables batch.
    operators: [BLOCKRUN_SOL_OPERATOR],
    // Most escrow at stake in the channel: deposited and not yet settled. Default: "$1".
    maxDeposit: '$5',
  },
});

// The first call opens the channel. The deposit is the 402's extra.minDeposit
// (the @x402/svm server defaults it to 3x this call's ceiling), or 5x the
// ceiling when the 402 names none, never more than the room maxDeposit leaves.
// The call that opens or tops up the channel is charged its quoted price, as
// it would be with exact.
await client.chat('openai/gpt-4o-mini', 'gm');

// Every later call is metered: you pay for the tokens the call actually used.
const reply = await client.chat('anthropic/claude-sonnet-4.6', 'Summarize x402 in one line', {
  maxTokens: 2048, // a ceiling, not a price: a short answer is not billed for 2,048 tokens
});

console.log(client.getSpending()); // { totalUsd: <actual charges>, calls: 2 }

// Done for good? Close the channel to get the unused escrow back.
// BlockRun closes it cooperatively when it can; otherwise this starts a
// payer-forced close and the escrow returns after the channel's grace period.
await client.closeBatchChannel();
```

## Trust and spending boundary

- **Explicit trust.** `operators` is required and has no implicit default. The
  package exports BlockRun's production public key as `BLOCKRUN_SOL_OPERATOR`
  (`5YKPQUFjw5WQqhSUkEGKNNfYYVqnRRNbpYyL71qQ1vm3`) so applications do not
  duplicate it. The SDK never learns a trusted key from an untrusted 402.
- **Bounded exposure.** `maxDeposit` caps the escrow at stake: the channel's
  deposit minus what has already been settled on-chain. A top-up is allowed
  only while `(deposit - settled) + topUp <= maxDeposit`, so a long-lived
  channel keeps topping up as BlockRun settles what it charged, and its
  unsettled balance never exceeds the cap. In server-signed mode that makes
  `maxDeposit` the most the selected operator could claim beyond what has
  already been settled, without another authorization from the payer. Before a
  top-up the SDK reads the channel's settled amount from the chain; if the
  RPC cannot answer, it assumes nothing was settled. If the account there
  cannot be read as a payment channel (another owner, too short, an
  unsupported encoding), or the installed `@x402/svm` lays out channel
  accounts differently from what the SDK decodes, it signs no top-up and the
  call pays `exact` (`channel_unreadable`), keeping the record.
- **Key rotation.** `operators` accepts a list so an old and new BlockRun key can
  overlap during a controlled rotation.
- **Server-signed channels only.** Batch pays only into server-signed
  (operator) channels, the ones `closeBatchChannel()` can refund. A batch
  accept that is client-signed (`extra.voucherSigner` omitted or `"client"`),
  which a custom gateway could offer, is never paid: the SDK ignores it, and a
  402 whose only batch accepts are client-signed pays `exact`
  (`client_signed_not_supported`). A client-signed channel an earlier SDK
  version opened can still be closed: `closeBatchChannel()` refunds a stored
  one through `@x402/svm`'s client-signed refund when the gateway's challenge
  offers its client-signed accept (after the trusted server-signed channel,
  when both are stored).

## Runtime behavior

Batch never pays twice for one call. Before a batch payment is sent, any
problem falls back to `exact`. Once it is sent, the SDK decides what the
gateway's answer proves, in one place:

| The gateway's answer to the payment | What the SDK does |
| --- | --- |
| a 2xx | the call is served and booked (a missing or unreconciled receipt only makes the SDK re-read the channel before the next payment) |
| first send: a 402, or a recognised refusal (`batch_payer_not_allowed`, `batch_payer_not_admitted`, `batch_admission_paused`, `batch_server_signed_only`, `batch_unavailable`, `batch_channel_limit`, `PAYMENT_VERIFICATION_UNAVAILABLE`), with no receipt or a failed one with no transaction | nothing was charged: pays `exact`. A deposit refused with a 402 or `PAYMENT_VERIFICATION_UNAVAILABLE` may still have been broadcast, so its channel is re-read from the chain before anything pays into it again, unless the 402's failed receipt names one of PayAI's `batch_*` admission refusals (capacity, rate, new channels disabled, account paused, fee-payer lane, deposit terms): that proves nothing was broadcast, so the deposit is forgotten, and the wallet's calls pay `exact` at once, without trying batch (`fallback` / `admission_refused`), for `Retry-After` (at most 15 min), else 60s, or 10 min when the deposit's own amount, asset or withdraw delay was refused |
| first send: a 429 whose failed receipt proves nothing was broadcast (`batch_account_channel_capacity_exhausted`, `batch_channel_capacity_exhausted`, `batch_deposit_rate_limited`) | nothing was charged: backs off, then pays again with a new batch payment from a fresh 402; `exact` once `rateLimit` runs out |
| first send: a 429 with no receipt | **in doubt**: after the backoff, replays the identical payment **once**; a 2xx with a success receipt ends it, anything else raises. A payment carrying a payment identifier is replayed as in the last row instead |
| first send of an authorization: an error status with a cancelled receipt (`success: false`, `errorReason: "batch_cancelled"`, no transaction) | nothing was charged: the error is raised with retry disposition `'unpaid'`, so `fallbackModels` / `smartChat()` move on to the next model (a `recovered` event, `batch_cancelled`) |
| anything else: a timeout, an abort or a network error after sending; a 5xx or other error status without a recognised refusal; a receipt naming a transaction, saying `settlement_pending` or saying it succeeded on an error status; a 429 with any other receipt | **in doubt**: raises `BatchPaymentUnresolvedError`, unless the payment carries a payment identifier (below) |
| a payment carrying a payment identifier, in doubt: no answer, a 5xx, a 429, or a 409 with `Retry-After` | **in doubt**: waits `Retry-After` (at least 1 s, at most 30 s; without one about 1s, 2s, 4s... with jitter), then replays the identical payment, and again for as long as the answer is one of these, within `inDoubt.maxWaitMs` (default 5 minutes). A 2xx with a success receipt ends it. Any other answer (a 409 without `Retry-After`, a 402, a 2xx without a receipt the SDK can verify), or running out of time, raises |

## Payment identifier

When the gateway's 402 declares the x402 `payment-identifier` extension,
every batch payment carries a new id in its `extensions` (`pay_` and 32 hex
digits). A gateway that stores each paid response under its id answers a
replay of a completed request with the original response and receipt, and
the call is served and booked once; while the original is still running, it
answers 409 with a `Retry-After`.

Every replay repeats the payment byte for byte: the same `PAYMENT-SIGNATURE`
header (same id, same request id, same signed authorization and deposit
transaction) and the same request body, which the SDK serializes once per
call. This also recovers a generation that outlasts the client's `timeout`
(60 s by default): the request is aborted, and the replays pick up its stored
response once the gateway has it.

The replay resolves the call only on a 2xx whose receipt the SDK can verify
(`success: true`, and an `extra` with the operator's `voucher` for this
request's charge and a `commitmentId`; a `channelState`, when present, must
match). Every error answer, and a replay's 2xx without a success receipt, is
held back from the channel's bookkeeping until no replay follows it; the
bookkeeping then takes the last answer, unless an earlier one carried a
success receipt and the later ones do not, so a charge the gateway reported
on an error status is never rolled back by a replay's refusal. These replays
do not count against `rateLimit`.

An `exact` payment carries its own new id when the extension is declared, so
a gateway that declares it `required` takes the exact fallback too. Without
the extension nothing changes.

## Trust model

The gateway is already trusted with the escrow up to `maxDeposit`, so its
explicit answer to a payment's first send is taken as proof that nothing was
charged. Nothing else is: not an error's type or `cause.code` (a request can
reach the gateway before the connection fails), not a missing receipt, and
not chain state. An answer to a replay only describes the replay: a 402 or
`duplicate_settlement` on a replay means the original reached the gateway, so
it stays in doubt.

## In doubt means raised, never paid again

A call in doubt throws `BatchPaymentUnresolvedError` and is never paid again:
no new authorization, no new deposit, no `exact`, and no `fallbackModels` or
`smartChat()` fallback model (it is a `PaymentError` whose retry disposition
is `'paid-or-in-doubt'`). It carries `wallet`, `requestId` (the payment that
may have been charged), `channelId`, `payloadKind` (`'open'`, `'top-up'` or
`'authorization'`), `depositInDoubt`, `status` (the gateway's last answer,
when there was one), `cause` (that answer as an `APIError`, or the transport
error) and `reason`:

- `'replay_unresolved'`: a 429 without a receipt whose one replay got no
  success receipt (or `rateLimit` left no room to replay it), or a payment
  carrying a payment identifier whose replays got none: the last answer was
  one no later replay can change, or `inDoubt.maxWaitMs` ran out (the message
  says how many replays were sent);
- `'ambiguous_rate_limit'`: a 429 whose receipt does not prove nothing was
  broadcast;
- `'no_response'`: sending it threw (timeout, abort, network error);
- `'duplicate_settlement'`: the first answer was a 402 naming
  `duplicate_settlement`, meaning another copy of this payment had already
  reached the gateway;
- `'outcome_unknown'`: any other answer that neither serves the call nor
  proves nothing was charged.

A retry is up to you, and it is a new payment:

```typescript
import type { BatchPaymentUnresolvedError } from '@blockrun/llm';

try {
  await client.smartChat('Summarize x402 in one line');
} catch (err) {
  // Match by name: `instanceof` fails when the error comes from another
  // loaded copy of the SDK (the CJS and ESM builds side by side).
  if (err instanceof Error && err.name === 'BatchPaymentUnresolvedError') {
    const unresolved = err as BatchPaymentUnresolvedError;
    console.warn(`payment ${unresolved.requestId} from ${unresolved.wallet} may have been charged`);
  }
  throw err;
}
```

Raising is deliberately conservative. Resolving a payment in doubt
automatically needs the gateway's help: a receipt (`PAYMENT-RESPONSE`) on
every response to a paid request, and a request-status lookup that answers
for a request id and refuses (fences) one it never saw, in the spirit of
[idempotency keys](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/).
The SDK will use them once the gateway offers them.

## Safe fallback

These pay `exact` instead, before anything is sent or after an answer proving
nothing was charged:

- the 402 has no batch accept, offers only client-signed ones (`client_signed_not_supported`), or names an operator outside `operators`;
- the deposit the call needs does not fit in the room `maxDeposit` leaves;
- another batch call for the same wallet is in flight;
- a deposit is in doubt, or a channel record is being re-read from the chain (below);
- the gateway refuses batch, or a 402 answers the first send (see the table);
- a recent deposit was refused by a facilitator admission check (`admission_refused`, for the cooldown described in the table);
- the gateway still answers 429 after the retries `rateLimit` allows, when nothing was charged.

Parallel calls never queue behind the channel, except during a 429 cooldown (below).

## Deposit size

An open or top-up deposits the 402's `extra.minDeposit` when it is at least
the call's ceiling (the `@x402/svm` server defaults it to 3x the ceiling),
otherwise 5x the ceiling. It is never less than the call needs, and never more
than the room `maxDeposit` leaves: `maxDeposit - (deposit - settled)`, which
for an open is all of `maxDeposit`. A call whose shortfall does not fit pays
`exact` (`deposit_over_cap`).

## 429 means wait, not give up

After a 429 the call waits for `Retry-After` (seconds or an HTTP date; without
one, about 1s, 2s, 4s with jitter). A `Retry-After` that is not a finite delay
of at most a day is ignored, and the default backoff applies. While the wallet
cools down, its other calls wait as well instead of sending new channel opens.

`batch.rateLimit` bounds this per call: `maxAttempts` (default `3` batch
payments sent, the first and the one replay included) and `maxWaitMs`
(default `60000` ms spent waiting). The replays of a payment carrying a
payment identifier are bound by `batch.inDoubt.maxWaitMs` instead (default
`300000` ms, counted from its first answer in doubt, waits and replays
included; no replay starts once its wait would end past it, and one already
sent runs until its answer or the client's `timeout`; `0` never replays). A
call that cannot wait out `Retry-After` within what is left of `maxWaitMs`
pays `exact` at once, and the wallet's shared cooldown never lasts longer
than `maxWaitMs`, so no single header keeps batch off for longer than that.

A 429 that proves nothing was broadcast is paid again with a new payment,
rebuilt from a fresh 402 challenge (one unpaid request) because the
original's blockhash and slot hints may have gone stale. That unpaid request
is the call itself: if the gateway serves it (a 2xx), that response is the
call's result and nothing more is paid (a `recovered` event,
`served_unpaid_on_rechallenge`); if it gets any other answer or none, the
call throws that error with retry disposition `'unpaid'` (nothing was paid
for it, so `fallbackModels` may take over). It is never paid `exact` against
the stale challenge. A 429 without a receipt is never rebuilt: it gets its
one replay, byte for byte (same request id, same signed authorization, same
signed deposit transaction).

## A deposit in doubt blocks new deposits

When an open or top-up is in doubt, or a deposit-bearing call was served
without a receipt the SDK could reconcile, the wallet signs no batch payment
at all (so no second deposit can land next to it) and its calls pay `exact`
(`channel_resync_pending`) until the chain settles the deposit.

The SDK reads channels at `finalized` commitment only. A deposit has landed
once the finalized channel holds it. It has provably never landed once the
finalized chain is 300 blocks past a block height the SDK read itself after
the payment was built (a transaction expires 150 blocks after its
blockhash), and a read at least that recent still does not show it: then an
open's record is dropped and a top-up's channel is rewritten with the
deposit it really has. Wall-clock time, and any `lastValidBlockHeight` a 402
names, are never used. This settles only the deposit, never whether the
gateway charged the payment that carried it.

## Events and stats

**No silent fallbacks.** Every fallback, every 429 backoff, every recovery,
every channel re-read and every payment raised in doubt writes one line to
stderr, each time it happens:

```text
[@blockrun/llm] batch-settlement event=backoff reason=rate_limited status=429 errorReason=batch_deposit_rate_limited retryAfterMs=30000 attempt=1 wallet=<address> next=retry
[@blockrun/llm] batch-settlement event=unresolved reason=no_response attempt=1 wallet=<address> next=raise detail="the payment got no answer (AbortError: This operation was aborted); it may have been charged, so it is not paid again"
```

`batch.onEvent` receives each one as a `SolanaBatchEvent`:
`{ type: 'fallback' | 'backoff' | 'recovered' | 'resync' | 'unresolved', reason, status?, errorReason?, retryAfterMs?, attempt?, detail?, wallet, at }`.
`reason` is a stable code:

| Event type | `reason` values |
| --- | --- |
| `backoff` | `rate_limited`, `cooldown`, `in_doubt` |
| `recovered` | the backoff reason it followed (`rate_limited`, `cooldown`, `in_doubt`), `served_unpaid_on_rechallenge`, or `batch_cancelled` |
| `fallback` | `not_offered`, `client_signed_not_supported`, `channel_busy`, `untrusted_operator`, `deposit_over_cap`, `channel_pending`, `closed_during_call`, `peer_dependency_missing`, `payment_creation_failed`, `wallet_config_conflict`, `channel_store_locked`, `deposit_journal_unreadable`, `deposit_journal_failed`, `channel_resync_pending`, `channel_resync_failed`, `channel_unreadable`, `payment_required`, `admission_refused`, `rate_limited`, or one of the recognised refusal codes (`batch_payer_not_allowed`, `batch_payer_not_admitted`, `batch_admission_paused`, `batch_server_signed_only`, `batch_unavailable`, `batch_channel_limit`, `PAYMENT_VERIFICATION_UNAVAILABLE`) |
| `resync` | `deposit_unanswered`, `deposit_failed`, `deposit_rate_limited`, `deposit_refused`, `receipt_missing`, `receipt_unreconciled`, `orphaned_deposit`, `deposit_unrecorded`, `channel_unusable` |
| `unresolved` | the `BatchPaymentUnresolvedError` reasons: `replay_unresolved`, `ambiguous_rate_limit`, `no_response`, `duplicate_settlement`, `outcome_unknown` |

The callback may be async; one that throws or rejects is logged and never
affects the payment. `client.getBatchStats()` returns this client's counters:

```typescript
import { SolanaLLMClient, BLOCKRUN_SOL_OPERATOR } from '@blockrun/llm';

const client = new SolanaLLMClient({
  batch: {
    operators: [BLOCKRUN_SOL_OPERATOR],
    rateLimit: { maxAttempts: 3, maxWaitMs: 60_000 }, // the defaults
    inDoubt: { maxWaitMs: 300_000 }, // the default
    onEvent: (event) => metrics.increment(`batch.${event.type}`, { reason: event.reason }),
  },
});

client.getBatchStats();
// { fallbacks: 1, fallbacksByReason: { rate_limited: 1 }, backoffs: 2, retries: 2, recoveries: 0,
//   resyncs: 0, unresolved: 0, unresolvedByReason: {} }
```

## Scope

Batch covers non-streaming chat: `chat`, `chatCompletion`, `smartChat`, and
`smartChatCompletion`. `stream()` and the image and media jobs still pay with
`exact`.

## One channel per wallet

Every `SolanaLLMClient` for a wallet in one process shares a single channel,
including clients built from different loaded copies of this package (its CJS
and ESM builds, or two installs). A second client with different `batch`
options pays `exact`.

On disk, one live process owns a wallet's channel file through a lock file
holding its pid, in the same format earlier releases write and read, so a
process still on an older version that shares the channel store (say, during
a rolling upgrade) sees the lock as live too; a random ownership token sits
beside it in `<lock>.owner`. Other processes pay `exact` until that process
exits. A lock that names the current process but was not taken by this SDK
version is never treated as stale; if no process uses it (say, a crashed
process whose pid was reused), delete the `.lock` and `.lock.owner` files.

## State and crash safety

The open channel is saved to `~/.blockrun/solana-batch/<wallet>.json` (mode
`0600`), so a restart reuses it; a custom `channelStore` path must also be per
wallet.

Before an open or top-up is sent, its intent is written to
`<wallet>.json.deposit-intents` beside it (the store's full path plus
`.deposit-intents`, so every store has its own; mode `0600`; the file and its
directory are fsynced where the platform allows), and removed once the
deposit is reconciled. After a crash, every intent left there makes the new
process treat that deposit as in doubt (above): it signs no deposit until the
chain settles it, and it never re-sends the old payment or pays for its
request again. A deposit that cannot be journaled is not sent
(`deposit_journal_failed`, paid `exact`).

Intents an earlier version journaled under its old name
(`<wallet>.deposit-intents.json`, which a store named `<wallet>` without
`.json` shared) are moved over on start, only the ones for this wallet; an
old journal that cannot be read keeps batch off as below. Only a missing
journal counts as empty: one that cannot be read, or is not a well-formed
journal this version knows (a missing `intents`, an unknown `version`, a
malformed entry), keeps batch off for the wallet and its calls pay `exact`
(`deposit_journal_unreadable`); the file is left as it is.

**With `channelStore: false` this crash recovery is not available:** the
channel is kept in memory and found again on-chain, and a deposit that was in
flight when the process died is not known to be in doubt. Nothing coordinates
processes in that mode either, so use it for a single process per wallet.

## Closing

`closeBatchChannel()` closes the channel the gateway's current 402 names: the
one for its trusted operator, receiver authorizer, fee payer, asset and
receiver. It first re-reads that record if it is in doubt (for example after a
process died mid-deposit) and loads that channel alone, so the escrow can be
recovered without another paid call; after the close the SDK forgets that
channel only. During a key rotation, a channel opened with the other operator
key keeps its record and can be closed once the gateway names that operator. A
client-signed channel left by an earlier SDK version is closed the same way
once no trusted server-signed record is left for that challenge, through the
challenge's client-signed accept.

It closes nothing and throws `BatchCloseDeferredError` while a chat call for
the wallet is in flight (`reason: 'call_in_flight'`, including one waiting out
a 429 or between the replays of a payment in doubt, so that retry can never
open a channel you believe is closed) or while any of its deposits is in doubt
(`reason: 'deposit_in_doubt'`, with `channelIds`); call it again once the call
returns or the deposit is settled (usually a few minutes: it waits for
finality). A chat that was still waiting for its first answer when a close
completed pays `exact` instead of opening a new channel (`closed_during_call`).

## RPC

Batch uses the same Solana RPC as `exact`: `rpcUrl` / `SOLANA_RPC_URL`, with
`rpcHeaders` / `SOLANA_RPC_HEADERS` / `SOLANA_RPC_API_KEY` for header-auth
endpoints. `@x402/svm` builds its RPC client from a URL alone, so when headers
are configured the SDK adds them through a thin wrapper around the global
`fetch` that only touches requests to exactly that RPC URL made during a batch
payment. The RPC must support `finalized` commitment and `minContextSlot`
(standard on current Solana RPCs); one that does not keeps calls on `exact`.

## A funded channel is never forgotten

A refused or rate-limited open or top-up that charged nothing leaves the saved
channel exactly as it was confirmed. When the SDK cannot trust its record — a
deposit in doubt; a response whose receipt is missing or was rebuilt without a
voucher; a pending deposit or journaled intent left by a process that died; a
chain that shows more deposit than the record before a top-up — it re-reads
that one channel by its address (`getAccountInfo` at `finalized`, no program
scan) before the next payment, and rewrites the record with the on-chain
deposit and the highest of its confirmed cumulative charge, the one the saved
record already holds, and the on-chain settled amount. The saved cumulative
never moves backwards, even when a journaled intent outlived the receipt that
reconciled its deposit (vouchers are redeemed on-chain later, so the settled
amount can lag).

Each re-read emits a `resync` event (`reason`: `deposit_unanswered`,
`deposit_failed`, `deposit_rate_limited`, `deposit_refused`,
`receipt_missing`, `receipt_unreconciled`, `orphaned_deposit`,
`deposit_unrecorded`, `channel_unusable`; `detail`: what the chain showed).

A top-up never goes into a channel the chain shows closing or closed, or that
is not your wallet's for its operator and mint: that record is re-read at once
(`channel_unusable`), a closed channel's record is dropped and the call
carries on as with no channel (a fresh open when it fits in `maxDeposit`), and
anything else keeps the record and pays `exact` (`channel_unreadable`). Until
it succeeds, calls pay `exact` (`channel_resync_pending`, or
`channel_resync_failed` when the chain cannot be read).

Only an absent account counts as "no channel": an account at that address that
cannot be read as your channel (another owner, layout, encoding, payer,
operator or mint) keeps the record and pays `exact` (`channel_unreadable`), and
is never a reason to sign a new deposit. Every channel read (these re-reads and
the settled read before a top-up) first checks that the installed `@x402/svm`
still uses the channel layout the SDK decodes; when it does not, nothing is
decoded and those calls pay `exact` (`channel_unreadable`) with the record
kept.

## Rollout

`sol.blockrun.ai` lists `exact` first and advertises `batch-settlement` only
when it is enabled. A configured client remains fully compatible while rollout
is paused or restricted because it falls back to `exact`.
