import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { unwrapBs58, bs58 } from "../../src/bs58";

// The CJS build saw bs58 as `{ default: codec }` (bs58 v6 CJS + tsup's
// node-mode __toESM), so every bs58.encode call threw there. These pin the
// unwrap against BOTH real shapes, taken from the installed package rather
// than a hand-written fixture.
const require = createRequire(import.meta.url);

describe("unwrapBs58", () => {
  it("premise: bs58's own CJS entry nests the codec under default", () => {
    const cjs = require("bs58") as { encode?: unknown; default?: { encode?: unknown } };
    expect(typeof cjs.encode).toBe("undefined");
    expect(typeof cjs.default?.encode).toBe("function");
  });

  it("unwraps the CJS shape the bundled build sees: { default: codec }", () => {
    const cjs = require("bs58");
    const codec = unwrapBs58({ default: cjs.default ?? cjs });
    expect(codec.encode(new Uint8Array([0, 1, 2]))).toBe("15T");
  });

  it("passes the ESM shape through unchanged", () => {
    expect(unwrapBs58(bs58)).toBe(bs58);
    expect(bs58.encode(new Uint8Array([0, 1, 2]))).toBe("15T");
  });

  it("throws on a module with no codec rather than failing later at encode()", () => {
    expect(() => unwrapBs58({})).toThrow(/no encode/);
    expect(() => unwrapBs58({ default: {} })).toThrow(/no encode/);
  });
});
