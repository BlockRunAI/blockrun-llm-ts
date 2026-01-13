/**
 * BlockRun Wallet Management - Auto-create and manage wallets.
 *
 * Provides frictionless wallet setup for new users:
 * - Auto-creates wallet if none exists
 * - Stores key securely at ~/.blockrun/.session
 * - Generates EIP-681 URIs for easy MetaMask funding
 */

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// USDC on Base contract address
export const USDC_BASE_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CHAIN_ID = "8453";

// Wallet storage location
const WALLET_DIR = path.join(os.homedir(), ".blockrun");
const WALLET_FILE = path.join(WALLET_DIR, ".session");

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
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true });
  }
  fs.writeFileSync(WALLET_FILE, privateKey, { mode: 0o600 });
  return WALLET_FILE;
}

/**
 * Load wallet private key from file.
 *
 * @returns Private key string or null if not found
 */
export function loadWallet(): string | null {
  // Check .session first (preferred)
  if (fs.existsSync(WALLET_FILE)) {
    const key = fs.readFileSync(WALLET_FILE, "utf-8").trim();
    if (key) return key;
  }

  // Check legacy wallet.key
  const legacyFile = path.join(WALLET_DIR, "wallet.key");
  if (fs.existsSync(legacyFile)) {
    const key = fs.readFileSync(legacyFile, "utf-8").trim();
    if (key) return key;
  }

  return null;
}

/**
 * Get existing wallet or create new one.
 *
 * Priority:
 * 1. BLOCKRUN_WALLET_KEY environment variable
 * 2. ~/.blockrun/.session file
 * 3. ~/.blockrun/wallet.key file (legacy)
 * 4. Create new wallet
 *
 * @returns WalletInfo with address, privateKey, and isNew flag
 */
export function getOrCreateWallet(): WalletInfo {
  // Check environment variable first
  const envKey =
    typeof process !== "undefined" && process.env
      ? process.env.BLOCKRUN_WALLET_KEY || process.env.BASE_CHAIN_WALLET_KEY
      : undefined;

  if (envKey) {
    const account = privateKeyToAccount(envKey as `0x${string}`);
    return { address: account.address, privateKey: envKey, isNew: false };
  }

  // Check file
  const fileKey = loadWallet();
  if (fileKey) {
    const account = privateKeyToAccount(fileKey as `0x${string}`);
    return { address: account.address, privateKey: fileKey, isNew: false };
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
  const envKey =
    typeof process !== "undefined" && process.env
      ? process.env.BLOCKRUN_WALLET_KEY || process.env.BASE_CHAIN_WALLET_KEY
      : undefined;

  if (envKey) {
    return privateKeyToAccount(envKey as `0x${string}`).address;
  }

  const fileKey = loadWallet();
  if (fileKey) {
    return privateKeyToAccount(fileKey as `0x${string}`).address;
  }

  return null;
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

// Export constants
export const WALLET_FILE_PATH = WALLET_FILE;
export const WALLET_DIR_PATH = WALLET_DIR;
