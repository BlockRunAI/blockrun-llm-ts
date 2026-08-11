/**
 * Lazy loaders for the optional Solana peer dependencies.
 *
 * `@solana/web3.js` and `@solana/spl-token` are optional PEER dependencies, not
 * optional dependencies, so npm does not install them for you. That is
 * deliberate: `@solana/spl-token` pulls `@solana/buffer-layout-utils` ->
 * `bigint-buffer`, whose native `toBigIntLE()` has an unpatched buffer overflow
 * (GHSA-3gc7-fjrx-p6mg) with no fixed release anywhere — 1.1.5 is the last
 * publish, from 2019, and the @trufflesuite fork ships byte-identical C. As an
 * optionalDependency it landed in the lockfile of every consumer, including the
 * ones that only ever make Base/EVM payments and never touch this code path.
 *
 * Callers that never use Solana now carry nothing. Callers that do install
 * the two packages explicitly — optional peers keep a vulnerable transitive
 * chain (`bigint-buffer`, no fixed release) out of Base-only consumers.
 *
 * Without this module the failure surfaces as a bare ERR_MODULE_NOT_FOUND from
 * somewhere inside a payment call, which reads like a bug in this SDK rather
 * than a missing install.
 */

const INSTALL_HINT =
  "npm install @solana/web3.js @solana/spl-token   (or pnpm add / yarn add)";

function missing(pkg: string, what: string, cause: unknown): Error {
  return new Error(
    `@blockrun/llm: ${what} requires the optional peer dependency "${pkg}", ` +
      `which is not installed.\n\n  ${INSTALL_HINT}\n\n` +
      `Solana packages are optional peers so that consumers who only use Base/EVM ` +
      `payments do not inherit them. If you only make Base payments, you should not ` +
      `be reaching this code path — check which chain you passed.\n` +
      `Original error: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

/** Load @solana/web3.js, or throw an error that says how to fix it. */
export async function loadSolanaWeb3(what: string): Promise<typeof import("@solana/web3.js")> {
  try {
    return await import("@solana/web3.js");
  } catch (err) {
    throw missing("@solana/web3.js", what, err);
  }
}

/** Load @solana/spl-token, or throw an error that says how to fix it. */
export async function loadSplToken(what: string): Promise<typeof import("@solana/spl-token")> {
  try {
    return await import("@solana/spl-token");
  } catch (err) {
    throw missing("@solana/spl-token", what, err);
  }
}
