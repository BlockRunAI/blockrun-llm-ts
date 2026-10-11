// The deposit-intent journal must be durable before a deposit is sent: the
// file's bytes fsynced, then renamed into place, then its directory fsynced
// (so the rename itself survives a power cut). `fs` is wrapped to record the
// order of those calls; every call still reaches the real filesystem.
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const fdPaths = new Map<number, string>();
  const name = (p: unknown) => path.basename(String(p));
  return {
    ...real,
    openSync: (file: string, flags?: string, mode?: number) => {
      const fd = real.openSync(file, flags, mode);
      fdPaths.set(fd, String(file));
      calls.push(`open ${name(file)}`);
      return fd;
    },
    fsyncSync: (fd: number) => {
      calls.push(`fsync ${name(fdPaths.get(fd))}`);
      return real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      calls.push(`rename ${name(from).replace(/\.\d+\.[0-9a-f-]+\.tmp$/, ".TMP")} -> ${name(to)}`);
      return real.renameSync(from, to);
    },
    unlinkSync: (file: string) => {
      calls.push(`unlink ${name(file)}`);
      return real.unlinkSync(file);
    },
  };
});

const fs = await import("fs");
const { FileIntentJournal } = await import("../../src/solana-batch");

describe("FileIntentJournal", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-intents-"));
    calls.length = 0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const intent = {
    key: "solana:mainnet:usdc:receiver",
    channelId: "chan",
    channelConfig: { voucherSigner: "server" },
    requestId: "req-1",
    kind: "open" as const,
    cumulative: "0",
    expectDeposit: "25000",
    at: 1,
  };

  it("lives beside the channel file, one journal per store", () => {
    expect(FileIntentJournal.beside(path.join(dir, "W1.json")).file).toBe(path.join(dir, "W1.json.deposit-intents"));
    expect(FileIntentJournal.beside(path.join(dir, "store")).file).toBe(path.join(dir, "store.deposit-intents"));
    // Two stores that differ only by `.json` never share a journal...
    expect(FileIntentJournal.beside(path.join(dir, "channels")).file).not.toBe(FileIntentJournal.beside(path.join(dir, "channels.json")).file);
    // ...and no journal is ever at the path earlier builds used for another store.
    expect(FileIntentJournal.beside(path.join(dir, "channels")).file).not.toBe(FileIntentJournal.legacyBeside(path.join(dir, "channels.json")));
    expect(FileIntentJournal.legacyBeside(path.join(dir, "channels.json"))).toBe(path.join(dir, "channels.deposit-intents.json"));
  });

  it("fsyncs the data, renames it into place, then fsyncs the directory", () => {
    const journal = FileIntentJournal.beside(path.join(dir, "W1.json"));
    journal.put(intent);

    const tmp = calls.find((c) => c.startsWith("open W1.json.deposit-intents."))!;
    expect(tmp).toBeDefined();
    const tmpName = tmp.slice("open ".length);
    expect(calls).toEqual([
      `open ${tmpName}`,
      `fsync ${tmpName}`,
      "rename W1.json.deposit-intents.TMP -> W1.json.deposit-intents",
      `open ${path.basename(dir)}`,
      `fsync ${path.basename(dir)}`,
    ]);
    expect(journal.list()).toEqual([intent]);
    if (process.platform !== "win32") expect(fs.statSync(journal.file).mode & 0o777).toBe(0o600);
  });

  it("removes the file once empty, and fsyncs the directory after the unlink", () => {
    const journal = FileIntentJournal.beside(path.join(dir, "W1.json"));
    journal.put(intent);
    calls.length = 0;

    journal.remove(intent.key);

    expect(calls).toEqual(["unlink W1.json.deposit-intents", `open ${path.basename(dir)}`, `fsync ${path.basename(dir)}`]);
    expect(fs.existsSync(journal.file)).toBe(false);
    expect(journal.list()).toEqual([]);
  });
});
