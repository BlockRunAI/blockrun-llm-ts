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
 * Requires @solana/web3.js (optional dep) — loaded lazily via dynamic
 * import so callers that never touch Solana don't pay the resolution cost
 * and ESM consumers don't trip over esbuild's __require shim.
 */
export async function createSolanaWallet(): Promise<{ address: string; privateKey: string }> {
  const { Keypair } = await import("@solana/web3.js");
  const bs58 = await import("bs58");
  const keypair = Keypair.generate();
  return {
    address: keypair.publicKey.toBase58(),
    privateKey: (bs58.default ?? bs58).encode(keypair.secretKey),
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
 * Discover ~/.<dir>/solana-wallet.json files from other providers.
 *
 * Each file should contain JSON with "privateKey" and "address" fields.
 * Also checks ~/.brcc/wallet.json for BRCC wallets.
 * Results are sorted by modification time (most recent first). Discovery is
 * opt-in and never changes the active BlockRun wallet automatically.
 *
 * @returns Array of wallet objects with secretKey and publicKey
 */
export function scanSolanaWallets(): Array<{ secretKey: string; publicKey: string; source: string }> {
  const home = os.homedir();
  const results: Array<{ mtime: number; secretKey: string; publicKey: string; source: string }> = [];

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
            results.push({ mtime, secretKey: pk, publicKey: addr, source: solanaWalletFile });
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
              results.push({ mtime, secretKey: pk, publicKey: addr, source: brccWalletFile });
            }
          } catch { /* skip */ }
        }
      }
    }
  } catch { /* ignore */ }

  results.sort((a, b) => b.mtime - a.mtime);
  return results.map(({ secretKey, publicKey, source }) => ({ secretKey, publicKey, source }));
}

export function loadSolanaWallet(): string | null {
  // The canonical BlockRun wallet always wins over a discovered provider key.
  if (fs.existsSync(SOLANA_WALLET_FILE)) {
    const key = fs.readFileSync(SOLANA_WALLET_FILE, "utf-8").trim();
    if (key) return key;
  }
  return null;
}

/**
 * List Solana wallets from other applications, safe to show to a user.
 *
 * Solana counterpart of `listDiscoveredWallets()`: no secret key is returned
 * and the address is derived from the key rather than trusted from the file.
 * Nothing here is active — adopt one with `importSolanaWallet()`.
 *
 * @returns Discovered wallets as `{ address, source }`, most recent first
 */
export async function listDiscoveredSolanaWallets(): Promise<
  Array<{ address: string; source: string }>
> {
  const listed: Array<{ address: string; source: string }> = [];
  for (const entry of scanSolanaWallets()) {
    try {
      listed.push({ address: await solanaPublicKey(entry.secretKey), source: entry.source });
    } catch {
      continue;
    }
  }
  return listed;
}

/**
 * Adopt a discovered Solana wallet, making it the active BlockRun wallet.
 *
 * Solana counterpart of `importWallet()`. Matching is done against the address
 * derived from each discovered key, and the current
 * `~/.blockrun/.solana-session` is backed up before being overwritten.
 *
 * @param address Address to adopt, as shown by `listDiscoveredSolanaWallets()`
 * @returns The adopted address
 * @throws If no discovered wallet derives to that address
 */
export async function importSolanaWallet(address: string): Promise<string> {
  const wanted = address.trim();

  for (const entry of scanSolanaWallets()) {
    let derived: string;
    try {
      derived = await solanaPublicKey(entry.secretKey);
    } catch {
      continue;
    }

    // Base58 is case-sensitive — compare exactly, unlike EVM hex.
    if (derived !== wanted) continue;

    if (fs.existsSync(SOLANA_WALLET_FILE)) {
      const current = fs.readFileSync(SOLANA_WALLET_FILE, "utf-8").trim();
      if (current && current !== entry.secretKey) {
        const backup = path.join(
          WALLET_DIR,
          `.solana-session.backup-${Math.floor(Date.now() / 1000)}`
        );
        fs.writeFileSync(backup, current, { mode: 0o600 });
      }
    }

    saveSolanaWallet(entry.secretKey);
    return derived;
  }

  const available = (await listDiscoveredSolanaWallets()).map((w) => w.address);
  throw new Error(
    `No discovered wallet controls ${address}. ` +
      `Available: ${available.length ? available.join(", ") : "none"}`
  );
}

/**
 * Warn when a new Solana wallet was created while provider wallets exist.
 *
 * Solana counterpart of `formatWalletMigrationNotice`. Addresses are derived
 * from the discovered secret key rather than trusted from the file's "address"
 * field.
 *
 * @param newAddress Address of the wallet that was just created
 * @returns Formatted notice, or null if nothing was discovered
 */
export async function formatSolanaWalletMigrationNotice(
  newAddress: string
): Promise<string | null> {
  let discovered: Array<{ secretKey: string; publicKey: string }>;
  try {
    discovered = scanSolanaWallets();
  } catch {
    return null;
  }

  const addresses: string[] = [];
  for (const entry of discovered) {
    try {
      addresses.push(await solanaPublicKey(entry.secretKey));
    } catch {
      continue;
    }
  }

  if (addresses.length === 0) return null;

  const found = addresses.map((addr) => `  ${addr}`).join("\n");
  return `
NOTICE: BlockRun created a new Solana wallet, but also found existing
wallet(s) belonging to other applications on this system:

${found}

BlockRun now uses only its own wallet:

  ${newAddress}

Discovered wallets are never adopted automatically — one may belong to a
different application, or have been planted to make you fund an address you
do not control.

If an address above is yours and holds your USDC, adopt it deliberately:

  import { importSolanaWallet } from '@blockrun/llm';
  await importSolanaWallet("<address-from-the-list-above>");

Your current wallet is backed up first. You can also set
SOLANA_WALLET_KEY=<private-key> for a single run without changing anything.
`;
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

  // 2. Canonical BlockRun session file
  if (fs.existsSync(SOLANA_WALLET_FILE)) {
    const fileKey = fs.readFileSync(SOLANA_WALLET_FILE, "utf-8").trim();
    if (fileKey) {
      const address = await solanaPublicKey(fileKey);
      return { privateKey: fileKey, address, isNew: false };
    }
  }

  // 3. Create new wallet
  const { address, privateKey } = await createSolanaWallet();
  saveSolanaWallet(privateKey);
  return { address, privateKey, isNew: true };
}

export { SOLANA_WALLET_FILE as SOLANA_WALLET_FILE_PATH };
