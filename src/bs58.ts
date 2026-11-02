import bs58Import from "bs58";

/**
 * bs58, unwrapped so it works from BOTH builds of this SDK.
 *
 * bs58 v6 ships its CommonJS entry as `exports.default = codec` with
 * `__esModule: true`. tsup's CJS output loads it as
 * `__toESM(require("bs58"), 1)`, and in that node mode `.default` is the WHOLE
 * exports object, so a plain `import bs58 from "bs58"` sees
 * `{ default: codec }` and `bs58.encode` is undefined. The ESM build gets the
 * codec directly. Every CJS consumer hit it: batch settlement's channel read
 * ("import_bs582.default.encode is not a function", falling back to exact)
 * and the Solana poll-ownership headers.
 */
type Bs58Codec = typeof bs58Import;

export function unwrapBs58(mod: unknown): Bs58Codec {
  const m = mod as { encode?: unknown; default?: unknown };
  if (typeof m?.encode === "function") return m as Bs58Codec;
  const inner = m?.default as { encode?: unknown } | undefined;
  if (typeof inner?.encode === "function") return inner as Bs58Codec;
  throw new Error("bs58: no encode() on the module or its default export");
}

export const bs58: Bs58Codec = unwrapBs58(bs58Import);
