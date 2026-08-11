/**
 * BlockRun Wallet Management - Auto-create and manage wallets.
 *
 * Provides frictionless wallet setup for new users:
 * - Auto-creates wallet if none exists
 * - Stores key securely at ~/.blockrun/.session
 * - Generates EIP-681 URIs for easy MetaMask funding
 *
 * Key resolution, discovery, and adoption are delegated to `@blockrun/core`, the
 * shared kernel every BlockRun product reads. That is what guarantees this SDK,
 * the `blockrun` CLI, and clawrouter-codex all resolve the SAME wallet — the
 * behaviour is defined in one place instead of being re-implemented per product
 * and drifting. Kept SDK-local: the funding/messaging surface (SDK-specific),
 * plus createWallet()/saveWallet() as thin persistence wrappers for API
 * compatibility — they write to the same core-resolved path, per call.
 *
 * Because path resolution now comes from core, `BLOCKRUN_HOME` overrides the base
 * directory (previously this module always used the OS home directory). Treat
 * that variable as security-sensitive: it redirects where the signing key is
 * read from AND written to, so an environment that can set it controls the
 * wallet as surely as one that can set BLOCKRUN_WALLET_KEY.
 */

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  paths as corePaths,
  resolveFromFiles,
  resolvePrivateKey,
  listDiscoveredWallets as coreListDiscoveredWallets,
  scanWallets as coreScanWallets,
  adoptWallet as coreAdoptWallet,
} from "@blockrun/core";
import * as fs from "fs";

// USDC on Base contract address
export const USDC_BASE_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CHAIN_ID = "8453";

// Wallet storage location — resolved by core so every product agrees on it.
// Resolved PER CALL, never snapshotted at module load: core re-reads
// BLOCKRUN_HOME on every resolution, so a load-time snapshot here would let
// the read path (core) and the write path (saveWallet) disagree the moment
// BLOCKRUN_HOME changes after import (e.g. dotenv.config() running after the
// SDK import) — getOrCreateWallet() would then mint a fresh key and
// saveWallet() would clobber the user's real, possibly funded ~/.blockrun/
// .session with it, without a backup.
function walletDir(): string {
  return corePaths().dir;
}
function walletFile(): string {
  return corePaths().session;
}

export interface WalletInfo {
  privateKey: string;
  address: string;
  isNew: boolean;
}

export interface PaymentLinks {
  basescan: string;
  walletLink: string;
  ethereum: string;
  blockrun: string;
}

/**
 * Create a new Ethereum wallet.
 *
 * @returns Object with address and privateKey
 */
export function createWallet(): { address: string; privateKey: string } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    privateKey,
  };
}

/**
 * Save wallet private key to ~/.blockrun/.session
 *
 * @param privateKey - Private key string (with 0x prefix)
 * @returns Path to saved wallet file
 */
export function saveWallet(privateKey: string): string {
  const dir = walletDir();
  const file = walletFile();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  return file;
}

/**
 * Discover ~/.<dir>/wallet.json files from other providers.
 *
 * Each file should contain JSON with a "privateKey" field; the returned
 * address is DERIVED from that key (any "address" field in the file is
 * ignored, so a file cannot claim an address it holds no key for), and
 * entries whose key does not parse are dropped. Results are sorted by
 * modification time (most recent first). Discovery is intentionally opt-in:
 * a provider wallet must never replace the canonical BlockRun wallet merely
 * because it was written more recently.
 *
 * @returns Array of wallet objects with privateKey and derived address
 */
export function scanWallets(): Array<{ privateKey: string; address: string; source: string }> {
  return coreScanWallets();
}

/**
 * List wallets from other applications, safe to show to a user.
 *
 * Unlike `scanWallets()`, no private key is returned and the address is derived
 * from the key rather than read from the file, so a wallet file cannot claim an
 * address it has no key for.
 *
 * Nothing here is active. Adopt one deliberately with `importWallet()`.
 *
 * @returns Discovered wallets as `{ address, source }`, most recent first
 */
export function listDiscoveredWallets(): Array<{ address: string; source: string }> {
  return coreListDiscoveredWallets();
}

/**
 * Adopt a discovered wallet by address, making it the active BlockRun wallet.
 *
 * This is the deliberate migration path: automatic selection never adopts a
 * discovered wallet, but you can choose one whose funds you want to spend.
 * Matching is done against the address *derived from each discovered key*, so a
 * wallet file claiming someone else's address can never be selected by it.
 *
 * The current `~/.blockrun/.session` is backed up beside itself before being
 * overwritten, so adopting a wallet can't strand the funds in the old one.
 *
 * NOTE: this is NOT `@blockrun/core`'s `importWallet(rawPrivateKey)` — that
 * one persists a raw key and refuses to overwrite without `force`. This SDK
 * function adopts a DISCOVERED wallet by address and maps onto core's
 * `adoptWallet()`. Same name, different operation; don't mix them up when
 * importing from core directly.
 *
 * @param address Address to adopt, as shown by `listDiscoveredWallets()`
 * @returns The adopted address
 * @throws If no discovered wallet derives to that address
 */
export function importWallet(address: string): string {
  return coreAdoptWallet(address).address;
}

/**
 * Load wallet private key from file.
 *
 * Priority:
 * 1. ~/.blockrun/.session
 * 2. ~/.blockrun/wallet.key (legacy)
 *
 * @returns Private key string or null if not found
 */
export function loadWallet(): string | null {
  // The canonical BlockRun wallet always wins. core's resolveFromFiles() reads
  // .session then legacy and never adopts a wallet discovered in another
  // application's private storage.
  return resolveFromFiles()?.privateKey ?? null;
}

/**
 * Warn when a new wallet was created while other provider wallets exist.
 *
 * Automatic selection deliberately ignores wallets discovered in other
 * applications' directories, so a user who previously relied on that discovery
 * would otherwise land on an empty wallet with no explanation of where their
 * funds went. This notice names the discovered addresses and tells them how to
 * import one on purpose.
 *
 * Addresses are derived from the discovered private key rather than read from
 * the file's "address" field, so a file claiming an address it cannot sign for
 * cannot trick the user into importing it.
 *
 * @param newAddress Address of the wallet that was just created
 * @returns Formatted notice, or null if nothing was discovered
 */
export function formatWalletMigrationNotice(newAddress: string): string | null {
  let addresses: string[];
  try {
    // core derives each address from the discovered key, so a planted file cannot
    // name an address it has no key for and trick the user into importing it.
    addresses = coreListDiscoveredWallets().map((w) => w.address);
  } catch {
    return null;
  }

  if (addresses.length === 0) return null;

  const found = addresses.map((addr) => `  ${addr}`).join("\n");
  return `
NOTICE: BlockRun created a new wallet, but also found existing wallet(s)
belonging to other applications on this system:

${found}

BlockRun now uses only its own wallet:

  ${newAddress}

Discovered wallets are never adopted automatically — one may belong to a
different application, or have been planted to make you fund an address you
do not control.

If an address above is yours and holds your USDC, adopt it deliberately:

  import { importWallet } from '@blockrun/llm';
  importWallet("<address-from-the-list-above>");

Your current wallet is backed up first. You can also set
BLOCKRUN_WALLET_KEY=<private-key> for a single run without changing anything.
`;
}

/**
 * Get existing wallet or create new one.
 *
 * Priority:
 * 1. BLOCKRUN_WALLET_KEY environment variable
 * 2. ~/.blockrun/.session file
 * 3. ~/.blockrun/wallet.key file - legacy
 * 4. Create new wallet
 *
 * @returns WalletInfo with address, privateKey, and isNew flag
 */
export function getOrCreateWallet(): WalletInfo {
  // core's canonical order: env (BLOCKRUN_WALLET_KEY|BASE_CHAIN_WALLET_KEY) →
  // .session → legacy. Discovered provider wallets are deliberately excluded;
  // scanWallets() is exposed for the explicit migration flow only.
  const resolved = resolvePrivateKey();
  if (resolved) {
    const account = privateKeyToAccount(resolved.privateKey);
    return { address: account.address, privateKey: resolved.privateKey, isNew: false };
  }

  // Create new wallet
  const { address, privateKey } = createWallet();
  saveWallet(privateKey);
  return { address, privateKey, isNew: true };
}

/**
 * Get wallet address without exposing private key.
 *
 * @returns Wallet address or null if no wallet configured
 */
export function getWalletAddress(): string | null {
  const resolved = resolvePrivateKey();
  return resolved ? privateKeyToAccount(resolved.privateKey).address : null;
}

/**
 * Generate EIP-681 URI for USDC transfer on Base.
 *
 * @param address - Recipient Ethereum address
 * @param amountUsdc - Amount in USDC (default 1.0)
 * @returns EIP-681 URI string for MetaMask/wallet scanning
 */
export function getEip681Uri(address: string, amountUsdc: number = 1.0): string {
  // USDC has 6 decimals
  const amountWei = Math.floor(amountUsdc * 1_000_000);
  return `ethereum:${USDC_BASE_CONTRACT}@${BASE_CHAIN_ID}/transfer?address=${address}&uint256=${amountWei}`;
}

/**
 * Generate payment links for the wallet address.
 *
 * @param address - Ethereum address
 * @returns Object with various payment links
 */
export function getPaymentLinks(address: string): PaymentLinks {
  return {
    basescan: `https://basescan.org/address/${address}`,
    walletLink: `ethereum:${USDC_BASE_CONTRACT}@${BASE_CHAIN_ID}/transfer?address=${address}`,
    ethereum: `ethereum:${address}@${BASE_CHAIN_ID}`,
    blockrun: `https://blockrun.ai/fund?address=${address}`,
  };
}

/**
 * Format the message shown when a new wallet is created.
 *
 * @param address - New wallet address
 * @returns Formatted message string
 */
export function formatWalletCreatedMessage(address: string): string {
  const links = getPaymentLinks(address);

  return `
I'm your BlockRun Agent! I can access GPT-4, Grok, image generation, and more.

Please send $1-5 USDC on Base to start:

${address}

What is Base? Base is Coinbase's blockchain network.
You can buy USDC on Coinbase and send it directly to me.

What $1 USDC gets you:
- ~1,000 GPT-4o calls
- ~100 image generations
- ~10,000 DeepSeek calls

Quick links:
- Check my balance: ${links.basescan}
- Get USDC: https://www.coinbase.com or https://bridge.base.org

Questions? care@blockrun.ai | Issues? github.com/BlockRunAI/blockrun-llm-ts/issues

Key stored securely in ~/.blockrun/
Your private key never leaves your machine - only signatures are sent.
`;
}

/**
 * Format the message shown when wallet needs more funds.
 *
 * @param address - Wallet address
 * @returns Formatted message string
 */
export function formatNeedsFundingMessage(address: string): string {
  const links = getPaymentLinks(address);

  return `
I've run out of funds! Please send more USDC on Base to continue helping you.

Send to my address:
${address}

Check my balance: ${links.basescan}

What $1 USDC gets you: ~1,000 GPT-4o calls or ~100 images.
Questions? care@blockrun.ai | Issues? github.com/BlockRunAI/blockrun-llm-ts/issues

Your private key never leaves your machine - only signatures are sent.
`;
}

/**
 * Compact funding message (no QR) for repeated displays.
 *
 * @param address - Wallet address
 * @returns Short formatted message string
 */
export function formatFundingMessageCompact(address: string): string {
  const links = getPaymentLinks(address);
  return `I need a little top-up to keep helping you! Send USDC on Base to: ${address}
Check my balance: ${links.basescan}`;
}

// Exported path constants. NOTE: these are import-time snapshots kept for
// API compatibility (they have been `string` since 1.x). All internal reads
// and writes resolve paths per call via core; only these two exported values
// freeze the location observed at import. If BLOCKRUN_HOME may change after
// import, resolve paths yourself via @blockrun/core's paths().
export const WALLET_FILE_PATH = walletFile();
export const WALLET_DIR_PATH = walletDir();
