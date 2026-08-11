import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-wallet-test-"));
  temporaryHomes.push(home);
  return home;
}

/**
 * Base wallet resolution lives in @blockrun/core, which resolves its own paths and
 * honours BLOCKRUN_HOME. Mocking `os.homedir()` only redirects this package's own
 * module graph, so it would leave core reading the real home directory — point core
 * at the fixture instead.
 */
async function importWalletModule(home: string) {
  vi.resetModules();
  process.env.BLOCKRUN_HOME = home;
  const mod = await import("../src/wallet.js");
  // Guard: if core ever stops honoring BLOCKRUN_HOME (or starts caching paths
  // at module scope), every test below would silently run against the
  // developer's REAL home directory — and the adoption tests would overwrite
  // a real ~/.blockrun/.session. Fail loudly instead.
  expect(mod.WALLET_FILE_PATH.startsWith(home)).toBe(true);
  return mod;
}

/** Solana resolution is still SDK-local, so it reads os.homedir() directly. */
async function importSolanaWalletModule(home: string) {
  vi.resetModules();
  vi.doMock("os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => home };
  });
  return import("../src/solana-wallet.js");
}

const savedEnv: Record<string, string | undefined> = {
  BLOCKRUN_HOME: process.env.BLOCKRUN_HOME,
  BLOCKRUN_WALLET_KEY: process.env.BLOCKRUN_WALLET_KEY,
  BASE_CHAIN_WALLET_KEY: process.env.BASE_CHAIN_WALLET_KEY,
};

afterEach(() => {
  vi.doUnmock("os");
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (temporaryHomes.length > 0) {
    fs.rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
  }
});

describe("canonical wallet selection", () => {
  it("uses the BlockRun Base wallet instead of a newer provider wallet", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    const provider = path.join(home, ".agentcash");
    const blockrunKey = `0x${"1".repeat(64)}`;
    const providerKey = `0x${"2".repeat(64)}`;
    fs.mkdirSync(blockrun, { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), blockrunKey);
    fs.writeFileSync(path.join(provider, "wallet.json"), JSON.stringify({
      privateKey: providerKey,
      address: "0x0000000000000000000000000000000000000002",
    }));

    const { loadWallet, scanWallets } = await importWalletModule(home);

    expect(scanWallets()).toHaveLength(1);
    expect(loadWallet()).toBe(blockrunKey);
  });

  it("uses the BlockRun Solana wallet instead of a newer provider wallet", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    const provider = path.join(home, ".agentcash");
    const blockrunKey = "canonical-solana-key";
    fs.mkdirSync(blockrun, { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".solana-session"), blockrunKey);
    fs.writeFileSync(path.join(provider, "solana-wallet.json"), JSON.stringify({
      privateKey: "provider-solana-key",
      address: "ProviderAddress",
    }));

    const { loadSolanaWallet, scanSolanaWallets } = await importSolanaWalletModule(home);

    expect(scanSolanaWallets()).toHaveLength(1);
    expect(loadSolanaWallet()).toBe(blockrunKey);
  });

  it("mints a new wallet rather than adopting a discovered provider wallet", async () => {
    const home = temporaryHome();
    const provider = path.join(home, ".agentcash");
    const providerKey = `0x${"2".repeat(64)}`;
    fs.mkdirSync(path.join(home, ".blockrun"), { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(provider, "wallet.json"), JSON.stringify({
      privateKey: providerKey,
      address: "0x0000000000000000000000000000000000000002",
    }));

    delete process.env.BLOCKRUN_WALLET_KEY;
    delete process.env.BASE_CHAIN_WALLET_KEY;

    const { getOrCreateWallet, scanWallets } = await importWalletModule(home);

    // The provider wallet is genuinely on disk and discoverable...
    expect(scanWallets()).toHaveLength(1);

    const created = getOrCreateWallet();

    // ...but a brand new wallet is minted instead of adopting it.
    expect(created.isNew).toBe(true);
    expect(created.privateKey).not.toBe(providerKey);
  });

  it("still resolves the legacy ~/.blockrun/wallet.key instead of minting", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    const legacyKey = `0x${"3".repeat(64)}`;
    fs.mkdirSync(blockrun, { recursive: true });
    fs.writeFileSync(path.join(blockrun, "wallet.key"), legacyKey);

    delete process.env.BLOCKRUN_WALLET_KEY;
    delete process.env.BASE_CHAIN_WALLET_KEY;

    const { getOrCreateWallet } = await importWalletModule(home);
    const resolved = getOrCreateWallet();

    expect(resolved.isNew).toBe(false);
    expect(resolved.privateKey).toBe(legacyKey);
  });
});

describe("importing a discovered wallet", () => {
  it("adopts by derived address and makes it the active wallet", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    const provider = path.join(home, ".agentcash");
    const blockrunKey = `0x${"1".repeat(64)}`;
    const providerKey = `0x${"2".repeat(64)}`;
    fs.mkdirSync(blockrun, { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), blockrunKey);
    fs.writeFileSync(path.join(provider, "wallet.json"), JSON.stringify({
      privateKey: providerKey,
      address: "0xNotTheRealAddress",
    }));

    delete process.env.BLOCKRUN_WALLET_KEY;
    delete process.env.BASE_CHAIN_WALLET_KEY;

    const { importWallet, getOrCreateWallet } = await importWalletModule(home);
    const { privateKeyToAccount } = await import("viem/accounts");
    const providerAddress = privateKeyToAccount(providerKey as `0x${string}`).address;

    expect(importWallet(providerAddress)).toBe(providerAddress);

    // It is now active through the normal selection path.
    const active = getOrCreateWallet();
    expect(active.privateKey).toBe(providerKey);
    expect(active.isNew).toBe(false);
  });

  it("backs up the wallet it replaces", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    const provider = path.join(home, ".agentcash");
    const blockrunKey = `0x${"1".repeat(64)}`;
    const providerKey = `0x${"2".repeat(64)}`;
    fs.mkdirSync(blockrun, { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), blockrunKey);
    fs.writeFileSync(path.join(provider, "wallet.json"), JSON.stringify({
      privateKey: providerKey,
      address: "0xNotTheRealAddress",
    }));

    const { importWallet } = await importWalletModule(home);
    const { privateKeyToAccount } = await import("viem/accounts");
    importWallet(privateKeyToAccount(providerKey as `0x${string}`).address);

    const backups = fs.readdirSync(blockrun).filter((f) => f.startsWith(".session.backup-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(blockrun, backups[0]), "utf-8")).toBe(blockrunKey);
  });

  it("refuses an address no discovered key controls", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    const provider = path.join(home, ".agentcash");
    const blockrunKey = `0x${"1".repeat(64)}`;
    fs.mkdirSync(blockrun, { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), blockrunKey);
    fs.writeFileSync(path.join(provider, "wallet.json"), JSON.stringify({
      privateKey: `0x${"2".repeat(64)}`,
      address: "0xNotTheRealAddress",
    }));

    const { importWallet } = await importWalletModule(home);

    expect(() => importWallet("0xNotTheRealAddress")).toThrow(/No discovered wallet controls/);
    // The active wallet is untouched.
    expect(fs.readFileSync(path.join(blockrun, ".session"), "utf-8")).toBe(blockrunKey);
    expect(fs.readdirSync(blockrun).filter((f) => f.startsWith(".session.backup-"))).toHaveLength(0);
  });

  it("lists discovered wallets without exposing secrets", async () => {
    const home = temporaryHome();
    const provider = path.join(home, ".agentcash");
    const providerKey = `0x${"2".repeat(64)}`;
    fs.mkdirSync(path.join(home, ".blockrun"), { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(provider, "wallet.json"), JSON.stringify({
      privateKey: providerKey,
      address: "0xNotTheRealAddress",
    }));

    const { listDiscoveredWallets } = await importWalletModule(home);
    const { privateKeyToAccount } = await import("viem/accounts");

    const listed = listDiscoveredWallets();
    expect(listed).toHaveLength(1);
    expect(listed[0].address).toBe(privateKeyToAccount(providerKey as `0x${string}`).address);
    expect(listed[0].source).toContain(".agentcash");
    expect(JSON.stringify(listed)).not.toContain(providerKey);
  });
});

describe("wallet migration notice", () => {
  it("names the address the discovered key controls, not the file's claim", async () => {
    const home = temporaryHome();
    const provider = path.join(home, ".agentcash");
    const providerKey = `0x${"2".repeat(64)}`;
    fs.mkdirSync(path.join(home, ".blockrun"), { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(provider, "wallet.json"), JSON.stringify({
      privateKey: providerKey,
      address: "0xNotTheRealAddress",
    }));

    const { formatWalletMigrationNotice } = await importWalletModule(home);
    const { privateKeyToAccount } = await import("viem/accounts");
    const realAddress = privateKeyToAccount(providerKey as `0x${string}`).address;

    const notice = formatWalletMigrationNotice("0xNewWalletAddress");

    expect(notice).not.toBeNull();
    expect(notice).toContain(realAddress);
    expect(notice).not.toContain("0xNotTheRealAddress");
    expect(notice).toContain("0xNewWalletAddress");
    // Never leak the discovered private key.
    expect(notice).not.toContain(providerKey);
  });

  it("stays silent when no provider wallets exist", async () => {
    const home = temporaryHome();
    fs.mkdirSync(path.join(home, ".blockrun"), { recursive: true });

    const { formatWalletMigrationNotice } = await importWalletModule(home);

    expect(formatWalletMigrationNotice("0xNewWalletAddress")).toBeNull();
  });
});

describe("resolution order pinned against @blockrun/core", () => {
  it("prefers BLOCKRUN_WALLET_KEY over the on-disk .session wallet", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    fs.mkdirSync(blockrun, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), `0x${"1".repeat(64)}`);
    process.env.BLOCKRUN_WALLET_KEY = `0x${"4".repeat(64)}`;
    delete process.env.BASE_CHAIN_WALLET_KEY;

    const { getOrCreateWallet } = await importWalletModule(home);
    const wallet = getOrCreateWallet();

    expect(wallet.isNew).toBe(false);
    expect(wallet.privateKey).toBe(`0x${"4".repeat(64)}`);
  });

  it("falls back to BASE_CHAIN_WALLET_KEY when BLOCKRUN_WALLET_KEY is unset", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    fs.mkdirSync(blockrun, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), `0x${"1".repeat(64)}`);
    delete process.env.BLOCKRUN_WALLET_KEY;
    process.env.BASE_CHAIN_WALLET_KEY = `0x${"5".repeat(64)}`;

    const { getOrCreateWallet } = await importWalletModule(home);

    expect(getOrCreateWallet().privateKey).toBe(`0x${"5".repeat(64)}`);
  });

  it("prefers .session over legacy wallet.key when both exist", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    fs.mkdirSync(blockrun, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), `0x${"1".repeat(64)}`);
    fs.writeFileSync(path.join(blockrun, "wallet.key"), `0x${"3".repeat(64)}`);
    delete process.env.BLOCKRUN_WALLET_KEY;
    delete process.env.BASE_CHAIN_WALLET_KEY;

    const { loadWallet } = await importWalletModule(home);

    expect(loadWallet()).toBe(`0x${"1".repeat(64)}`);
  });

  it("normalizes an un-prefixed .session key to 0x form", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    fs.mkdirSync(blockrun, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), "1".repeat(64));
    delete process.env.BLOCKRUN_WALLET_KEY;
    delete process.env.BASE_CHAIN_WALLET_KEY;

    const { loadWallet, getWalletAddress } = await importWalletModule(home);

    expect(loadWallet()).toBe(`0x${"1".repeat(64)}`);
    expect(getWalletAddress()).toBeTruthy();
  });

  it("writes the minted key to the home it resolved from, even if BLOCKRUN_HOME changed after import", async () => {
    // Regression guard for the read/write split-brain: core resolves paths
    // per call, so saveWallet must too — a load-time snapshot would write
    // the fresh key into the OLD home, clobbering a possibly funded
    // .session there without a backup.
    const homeA = temporaryHome();
    delete process.env.BLOCKRUN_WALLET_KEY;
    delete process.env.BASE_CHAIN_WALLET_KEY;
    const mod = await importWalletModule(homeA);
    const fundedKey = `0x${"6".repeat(64)}`;
    fs.mkdirSync(path.join(homeA, ".blockrun"), { recursive: true });
    fs.writeFileSync(path.join(homeA, ".blockrun", ".session"), fundedKey);

    const homeB = temporaryHome();
    process.env.BLOCKRUN_HOME = homeB; // changed after import — no re-import

    const created = mod.getOrCreateWallet();
    expect(created.isNew).toBe(true);
    // The new key landed where resolution looked, not the stale snapshot...
    expect(fs.readFileSync(path.join(homeB, ".blockrun", ".session"), "utf-8"))
      .toBe(created.privateKey);
    // ...and the funded wallet in the original home is untouched.
    expect(fs.readFileSync(path.join(homeA, ".blockrun", ".session"), "utf-8"))
      .toBe(fundedKey);
    // A second call finds the wallet it just created.
    expect(mod.getOrCreateWallet().isNew).toBe(false);
  });

  it("re-adopting the already-active wallet does not create a backup", async () => {
    const home = temporaryHome();
    const blockrun = path.join(home, ".blockrun");
    const provider = path.join(home, ".agentcash");
    const key = `0x${"2".repeat(64)}`;
    fs.mkdirSync(blockrun, { recursive: true });
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(blockrun, ".session"), key);
    fs.writeFileSync(path.join(provider, "wallet.json"), JSON.stringify({ privateKey: key }));

    const { importWallet } = await importWalletModule(home);
    const { privateKeyToAccount } = await import("viem/accounts");
    importWallet(privateKeyToAccount(key as `0x${string}`).address);

    const backups = fs.readdirSync(blockrun).filter((f) => f.startsWith(".session.backup-"));
    expect(backups).toHaveLength(0);
  });
});
