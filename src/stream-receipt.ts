/**
 * The receipt of a STREAMED batch-settlement call.
 *
 * A buffered call's receipt is the `PAYMENT-RESPONSE` header. A stream's
 * headers leave before the charge is known, so sol.blockrun.ai sends the same
 * payload as one SSE event, just before `data: [DONE]` (chat) or
 * `event: message_stop` (messages), when the request carries
 * {@link STREAM_RECEIPT_HEADER}:
 *
 *   event: payment-response
 *   data: {"type":"payment_response","status":"charged","payment_response":"<base64>"}
 *
 * A stream that never delivers that event (cut, failed upstream, an older
 * gateway) is looked up afterwards at `POST /v1/batch/receipt`, keyed by the
 * payment the client signed.
 */

/** Request header that asks the gateway for the receipt as a final SSE event. */
export const STREAM_RECEIPT_HEADER = "X-BlockRun-Stream-Receipt";
const RECEIPT_EVENT = "payment-response";
const EVENT_END = /\r?\n\r?\n/;

/** What the receipt event said. `paymentResponse` is the header payload, when there is one. */
export interface StreamReceipt {
  status: string;
  paymentResponse?: string;
}

function isReceiptBlock(block: string): boolean {
  return block.split(/\r?\n/).some((line) => line.trim() === `event: ${RECEIPT_EVENT}` || line.trim() === `event:${RECEIPT_EVENT}`);
}

function parseReceiptBlock(block: string): StreamReceipt | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  try {
    const parsed = JSON.parse(data) as { status?: unknown; payment_response?: unknown };
    if (typeof parsed?.status !== "string") return undefined;
    return { status: parsed.status, ...(typeof parsed.payment_response === "string" ? { paymentResponse: parsed.payment_response } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The stream the caller reads: every byte as sent, minus the receipt event.
 * The caller did not ask for it, and a generic SSE reader would hand its JSON
 * over as if it were a chunk of the answer.
 */
export function withoutReceiptEvent(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let out = "";
        for (let match = EVENT_END.exec(pending); match; match = EVENT_END.exec(pending)) {
          const end = match.index + match[0].length;
          const block = pending.slice(0, end);
          pending = pending.slice(end);
          if (!isReceiptBlock(block)) out += block;
        }
        if (out) controller.enqueue(encoder.encode(out));
      },
      flush(controller) {
        const rest = pending + decoder.decode();
        if (rest && !isReceiptBlock(rest)) controller.enqueue(encoder.encode(rest));
      },
    })
  );
}

/**
 * Read a stream to its receipt event. Undefined when the stream ends (or
 * fails) without one. Stops reading as soon as the event arrives.
 */
export async function readReceiptEvent(body: ReadableStream<Uint8Array>): Promise<StreamReceipt | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return undefined;
      pending += decoder.decode(value, { stream: true });
      for (let match = EVENT_END.exec(pending); match; match = EVENT_END.exec(pending)) {
        const end = match.index + match[0].length;
        const block = pending.slice(0, end);
        pending = pending.slice(end);
        if (isReceiptBlock(block)) {
          void reader.cancel().catch(() => undefined);
          return parseReceiptBlock(block);
        }
      }
    }
  } catch {
    return undefined;
  } finally {
    try { reader.releaseLock(); } catch { /* cancelled */ }
  }
}

/** The answer of `POST /v1/batch/receipt`. */
export interface ReceiptLookup {
  status: string;
  payment_response?: string;
}

/**
 * Look a batch-paid request up after the fact, polling while the gateway
 * says it is still settling (a cut stream is charged when the model's turn
 * ends, seconds later). Undefined when it cannot be answered.
 */
export async function lookupReceipt(
  apiUrl: string,
  paymentHeader: string,
  opts: { fetch?: typeof fetch; attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<ReceiptLookup | undefined> {
  const doFetch = opts.fetch ?? fetch;
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(delayMs * 2 ** (attempt - 1), 15_000));
    let answer: ReceiptLookup | undefined;
    try {
      const res = await doFetch(`${apiUrl}/v1/batch/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentHeader }),
      });
      // A 5xx is the gateway, not the answer: ask again. Any other refusal is final.
      if (res.status >= 500) continue;
      if (!res.ok) return undefined;
      answer = (await res.json()) as ReceiptLookup;
    } catch {
      continue;
    }
    if (answer?.status !== "pending") return answer;
  }
  return undefined;
}

/** True for an SSE response. */
export function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/event-stream");
}
