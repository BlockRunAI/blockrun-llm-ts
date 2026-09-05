import { APIError } from "./types.js";
import { sanitizeErrorResponse, validateApiUrl } from "./validation.js";

/** Account billing is independent of the wallet payment chain. */
export interface ApiKeyOptions {
  /** BlockRun account key. Defaults to BLOCKRUN_API_KEY unless a privateKey is explicit. */
  apiKey?: string;
}

/** Gateway hiccups the account API can recover from. Mirrors the 5xx half of
 *  router-adapter's isTransientError. 429 is excluded on purpose: it carries a
 *  Retry-After the caller must honour, not something to paper over here. */
const TRANSIENT_STATUS = new Set([502, 503, 504, 522, 524]);
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = 1_000;

function retryDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const API_KEY_URL = "https://api.blockrun.ai";
export const PORTAL_URL = "https://user.blockrun.ai";

/** Resolve once per client. Explicit wallet credentials preserve wallet mode. */
export function resolveApiKeyAuth(
  options: ApiKeyOptions & { privateKey?: string; apiUrl?: string },
): ApiKeyAuth | undefined {
  if (options.apiKey !== undefined && options.privateKey !== undefined) {
    throw new Error("Pass either apiKey or privateKey, not both.");
  }
  const key = options.apiKey ?? (options.privateKey === undefined && typeof process !== "undefined"
    ? process.env?.BLOCKRUN_API_KEY : undefined);
  if (key === undefined) return undefined;
  if (!/^brk_[A-Za-z0-9_-]+$/.test(key.trim())) {
    throw new Error(`Invalid BlockRun API key. Create one at ${PORTAL_URL}/dashboard/keys.`);
  }
  const base = options.apiUrl ?? (typeof process !== "undefined"
    ? process.env?.BLOCKRUN_API_BASE_URL : undefined) ?? API_KEY_URL;
  return new ApiKeyAuth(key.trim(), base);
}

/** Throws for wallet-only operations instead of inventing a wallet identity. */
export function requireWallet<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("This operation requires a wallet; the client uses API key account billing.");
  return value;
}

export class ApiKeyAuth {
  readonly apiUrl: string;
  readonly #key: string;

  constructor(key: string, base: string) {
    validateApiUrl(base);
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("API base URL must not contain credentials, a query, or a fragment.");
    }
    // Public SDK methods append /v1 themselves. Accept the OpenAI-style base too.
    this.apiUrl = base.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.#key = key;
  }

  /** Resolve gateway poll paths without forwarding credentials to another origin. */
  resolveUrl(path: string): string {
    const url = new URL(path, this.apiUrl + "/");
    if (url.origin !== new URL(this.apiUrl).origin || url.username || url.password) {
      throw new Error("Refusing to send a BlockRun API key to a different origin.");
    }
    // Vendored gateway jobs can return the original /api/v1 polling path.
    if (new URL(this.apiUrl).pathname === "/" && url.pathname.startsWith("/api/v1/")) url.pathname = url.pathname.slice(4);
    return url.href;
  }

  async fetch(input: string | URL | Request, init?: RequestInit, raiseErrors = true): Promise<Response> {
    const request = input instanceof Request ? input : undefined;
    const url = this.resolveUrl(request?.url ?? String(input));
    const headers = new Headers(init?.headers ?? request?.headers);
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().includes("payment") || name.toLowerCase() === "x-api-key") headers.delete(name);
    }
    headers.set("authorization", `Bearer ${this.#key}`);
    // Only GET/HEAD may be re-sent. In account mode the first POST is the billed
    // one, so replaying it after a 502 risks a second job and a second charge —
    // the wallet path can retry freely because its first POST is the unpaid 402.
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const retries = method === "GET" || method === "HEAD" ? TRANSIENT_RETRIES : 0;
    const signal = init?.signal ?? request?.signal;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      // Never follow redirects with an account credential.
      response = await globalThis.fetch(request ? new Request(url, request) : url, {
        ...init, headers, redirect: "error",
      });
      if (attempt >= retries || !TRANSIENT_STATUS.has(response.status)) break;
      await response.body?.cancel();
      await retryDelay(TRANSIENT_BACKOFF_MS * (attempt + 1), signal);
    }
    if (raiseErrors && !response.ok) {
      let body: unknown;
      try { body = await response.json(); } catch { body = undefined; }
      const outer = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const detail = outer.error && typeof outer.error === "object"
        ? outer.error as Record<string, unknown> : outer;
      const safe = Object.fromEntries(["message", "code", "type", "param"].flatMap(name =>
        typeof detail[name] === "string" ? [[name, (detail[name] as string).split(this.#key).join("[REDACTED]")]] : []));
      const hint = response.status === 402 ? ` Top up at ${PORTAL_URL}/dashboard/credits.`
        : response.status === 401 ? ` Check your key at ${PORTAL_URL}/dashboard/keys.` : "";
      const error = new APIError(`BlockRun account API error: ${response.status}.${hint}`, response.status, safe);
      error.retryAfter = response.headers.get("retry-after") ?? undefined;
      throw error;
    }
    return response;
  }

  /** Poll an account-owned async job without ever entering the x402 signing path. */
  async poll<T>(response: Response, timeout: number, interval: number): Promise<T> {
    const deadline = Date.now() + timeout;
    let data = await response.json() as Record<string, unknown>;
    if (["failed", "cancelled", "canceled"].includes(String(data.status))) {
      throw new APIError("Account API job failed or was cancelled", 502);
    }
    const pollPath = data.poll_url;
    if (typeof pollPath !== "string") {
      if (response.status === 202 || ["queued", "in_progress", "processing"].includes(String(data.status))) {
        throw new APIError("Async response missing poll_url", response.status);
      }
      return data as T;
    }
    const url = this.resolveUrl(pollPath);
    while (Date.now() < deadline) {
      if (data.status === "completed") return data as T;
      if (["failed", "cancelled", "canceled"].includes(String(data.status))) {
        throw new APIError("Account API job failed or was cancelled", 502, sanitizeErrorResponse(data));
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const res = await this.fetch(url, { signal: AbortSignal.timeout(remaining) });
        data = await res.json() as Record<string, unknown>;
      } catch (err) {
        // The job is already submitted and already billed. A gateway hiccup on
        // one poll is not a reason to abandon it — keep asking until the
        // deadline. Auth, quota and not-found errors still fail immediately.
        if (!(err instanceof APIError) || !TRANSIENT_STATUS.has(err.statusCode)) throw err;
      }
    }
    if (data.status === "completed") return data as T;
    throw new APIError("Account API job polling timed out; check the job before submitting again.", 504, { poll_url: url });
  }
}
