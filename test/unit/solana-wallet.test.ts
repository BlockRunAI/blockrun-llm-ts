import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createSolanaWallet,
  solanaKeyToBytes,
  getOrCreateSolanaWallet,
} from "../../src/solana-wallet";

const TEST_BS58_KEY = "5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-solana-key-test-"));
  temporaryHomes.push(home);
  return home;
}

async function importSolanaWalletModule(home: string) {
  vi.resetModules();
  vi.doMock("os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => home };
  });
  return import("../../src/solana-wallet");
}

afterEach(() => {
  vi.doUnmock("os");
  delete process.env.SOLANA_WALLET_KEY;
  while (temporaryHomes.length > 0) {
    fs.rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
  }
});

describe("Solana Wallet", () => {
  it("createSolanaWallet returns address and privateKey", async () => {
    const wallet = await createSolanaWallet();
    expect(wallet.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58
    expect(wallet.privateKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/); // bs58 64-byte key
  });

  it("solanaKeyToBytes converts bs58 key to Uint8Array", async () => {
    const bytes = await solanaKeyToBytes(TEST_BS58_KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(64);
  });

  it("solanaKeyToBytes throws on invalid key", async () => {
    await expect(solanaKeyToBytes("invalid-key")).rejects.toThrow();
  });

  it("solanaKeyToBytes accepts the Solana CLI JSON array format", async () => {
    const canonical = await solanaKeyToBytes(TEST_BS58_KEY);
    const asJsonArray = JSON.stringify(Array.from(canonical));
    const bytes = await solanaKeyToBytes(asJsonArray);
    expect(bytes).toEqual(canonical);
  });

  it("solanaKeyToBytes accepts a 64-byte hex key with or without 0x", async () => {
    const canonical = await solanaKeyToBytes(TEST_BS58_KEY);
    const hex = Buffer.from(canonical).toString("hex");
    expect(await solanaKeyToBytes(hex)).toEqual(canonical);
    expect(await solanaKeyToBytes(`0x${hex}`)).toEqual(canonical);
  });

  it("solanaKeyToBytes identifies an EVM private key and says so", async () => {
    const evmKey = `0x${"ab".repeat(32)}`; // 32-byte hex — Base/EVM format
    await expect(solanaKeyToBytes(evmKey)).rejects.toThrow(/EVM/);
  });

  it("solanaKeyToBytes lists accepted formats on unrecognized input", async () => {
    await expect(solanaKeyToBytes("not/a/key!!")).rejects.toThrow(/base58/);
  });
});

describe("getOrCreateSolanaWallet error sources", () => {
  it("names SOLANA_WALLET_KEY when the env var holds a bad key", async () => {
    const mod = await importSolanaWalletModule(temporaryHome());
    process.env.SOLANA_WALLET_KEY = "not/a/key!!";
    await expect(mod.getOrCreateSolanaWallet()).rejects.toThrow(/SOLANA_WALLET_KEY/);
  });

  it("names the session file path when it holds a bad key", async () => {
    const home = temporaryHome();
    const dir = path.join(home, ".blockrun");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".solana-session"), "not/a/key!!");
    const mod = await importSolanaWalletModule(home);
    await expect(mod.getOrCreateSolanaWallet()).rejects.toThrow(/\.solana-session/);
  });

  it("adopts a session file stored in Solana CLI JSON array format", async () => {
    const real = await createSolanaWallet();
    const canonical = await solanaKeyToBytes(real.privateKey);
    const home = temporaryHome();
    const dir = path.join(home, ".blockrun");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".solana-session"), JSON.stringify(Array.from(canonical)));
    const mod = await importSolanaWalletModule(home);
    const wallet = await mod.getOrCreateSolanaWallet();
    const { Keypair } = await import("@solana/web3.js");
    const expected = Keypair.fromSecretKey(canonical).publicKey.toBase58();
    expect(wallet.address).toBe(expected);
  });
});
