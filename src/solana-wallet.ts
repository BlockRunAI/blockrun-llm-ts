/**
 * BlockRun Solana Wallet Management.
 * Stores keys as bs58-encoded strings at ~/.blockrun/.solana-session
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const WALLET_DIR = path.join(os.homedir(), ".blockrun");
const SOLANA_WALLET_FILE = path.join(WALLET_DIR, ".solana-session");

export interface SolanaWalletInfo {
  privateKey: string; // bs58-encoded 64-byte secret key
  address: string;    // base58 public key
  isNew: boolean;
}

/**
 * Create a new Solana wallet.
 * Requires @solana/web3.js (optional dep).
 */
export function createSolanaWallet(): { address: string; privateKey: string } {
  // Use dynamic require for optional dep
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require("@solana/web3.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs58 = require("bs58");
  const keypair = Keypair.generate();
  return {
    address: keypair.publicKey.toBase58(),
    privateKey: bs58.default?.encode(keypair.secretKey) ?? bs58.encode(keypair.secretKey),
  };
}

/**
 * Convert a bs58 private key string to Uint8Array (64 bytes).
 * Accepts: bs58-encoded 64-byte key (standard Solana format).
 */
export async function solanaKeyToBytes(privateKey: string): Promise<Uint8Array> {
  try {
    const bs58 = await import("bs58");
    const bytes = (bs58.default ?? bs58).decode(privateKey);
    if (bytes.length !== 64) {
      throw new Error(`Invalid Solana key length: expected 64 bytes, got ${bytes.length}`);
    }
    return bytes;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid Solana private key: ${msg}`);
  }
}

/**
 * Get Solana public key (address) from bs58 private key.
 */
export async function solanaPublicKey(privateKey: string): Promise<string> {
  const { Keypair } = await import("@solana/web3.js");
  const bytes = await solanaKeyToBytes(privateKey);
  return Keypair.fromSecretKey(bytes).publicKey.toBase58();
}

export function saveSolanaWallet(privateKey: string): string {
  if (!fs.existsSync(WALLET_DIR)) fs.mkdirSync(WALLET_DIR, { recursive: true });
  fs.writeFileSync(SOLANA_WALLET_FILE, privateKey, { mode: 0o600 });
  return SOLANA_WALLET_FILE;
}

/**
 * Scan ~/.<dir>/solana-wallet.json files from any provider.
 *
 * Each file should contain JSON with "privateKey" and "address" fields.
 * Also checks ~/.brcc/wallet.json for BRCC wallets.
 * Results are sorted by modification time (most recent first).
 *
 * @returns Array of wallet objects with secretKey and publicKey
 */
export function scanSolanaWallets(): Array<{ secretKey: string; publicKey: string }> {
  const home = os.homedir();
  const results: Array<{ mtime: number; secretKey: string; publicKey: string }> = [];

  try {
    const entries = fs.readdirSync(home, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(".") || !entry.isDirectory()) continue;

      // Check solana-wallet.json
      const solanaWalletFile = path.join(home, entry.name, "solana-wallet.json");
      if (fs.existsSync(solanaWalletFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(solanaWalletFile, "utf-8"));
          const pk = data.privateKey || "";
          const addr = data.address || "";
          if (pk && addr) {
            const mtime = fs.statSync(solanaWalletFile).mtimeMs;
            results.push({ mtime, secretKey: pk, publicKey: addr });
          }
        } catch { /* skip */ }
      }

      // Check ~/.brcc/wallet.json specifically
      if (entry.name === ".brcc") {
        const brccWalletFile = path.join(home, entry.name, "wallet.json");
        if (fs.existsSync(brccWalletFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(brccWalletFile, "utf-8"));
            const pk = data.privateKey || "";
            const addr = data.address || "";
            if (pk && addr) {
              const mtime = fs.statSync(brccWalletFile).mtimeMs;
              results.push({ mtime, secretKey: pk, publicKey: addr });
            }
          } catch { /* skip */ }
        }
      }
    }
  } catch { /* ignore */ }

  results.sort((a, b) => b.mtime - a.mtime);
  return results.map(({ secretKey, publicKey }) => ({ secretKey, publicKey }));
}

export function loadSolanaWallet(): string | null {
  // Scan provider wallet files
  const wallets = scanSolanaWallets();
  if (wallets.length > 0) return wallets[0].secretKey;

  // Legacy session file
  if (fs.existsSync(SOLANA_WALLET_FILE)) {
    const key = fs.readFileSync(SOLANA_WALLET_FILE, "utf-8").trim();
    if (key) return key;
  }
  return null;
}

export async function getOrCreateSolanaWallet(): Promise<SolanaWalletInfo> {
  // 1. Environment variable
  const envKey = typeof process !== "undefined" && process.env
    ? process.env.SOLANA_WALLET_KEY
    : undefined;
  if (envKey) {
    const address = await solanaPublicKey(envKey);
    return { privateKey: envKey, address, isNew: false };
  }

  // 2. Scan provider wallets
  const wallets = scanSolanaWallets();
  if (wallets.length > 0) {
    return { privateKey: wallets[0].secretKey, address: wallets[0].publicKey, isNew: false };
  }

  // 3. Legacy session file
  if (fs.existsSync(SOLANA_WALLET_FILE)) {
    const fileKey = fs.readFileSync(SOLANA_WALLET_FILE, "utf-8").trim();
    if (fileKey) {
      const address = await solanaPublicKey(fileKey);
      return { privateKey: fileKey, address, isNew: false };
    }
  }

  // 4. Create new wallet
  const { address, privateKey } = createSolanaWallet();
  saveSolanaWallet(privateKey);
  return { address, privateKey, isNew: true };
}

export { SOLANA_WALLET_FILE as SOLANA_WALLET_FILE_PATH };
