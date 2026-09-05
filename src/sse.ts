/**
 * Server-Sent Events parsing, shared by every streaming path in this SDK.
 *
 * It lives on its own because the Base and Solana clients now both stream, and
 * the parsing is not the interesting part of either — the payment handshake in
 * front of it is. A second copy would have drifted: the `[DONE]` sentinel, the
 * partial-line buffer across chunk boundaries, and the decision to skip a
 * malformed frame rather than abort the stream are each a behaviour a caller
 * depends on, and each was only written down once.
 *
 * @module
 */

/**
 * Yield each `data:` frame of an SSE response, parsed as JSON.
 *
 * Stops at `data: [DONE]` or when the upstream closes. A frame that does not
 * parse is SKIPPED rather than thrown: providers interleave keep-alives and
 * vendor-specific comment frames, and failing a whole answer over one of them
 * loses tokens the caller already paid for.
 *
 * The reader lock is released on the way out however the loop ends — including
 * a `break` in the caller's `for await`, which terminates this generator
 * through its `return()`.
 *
 * @param response - a streaming response whose body has not been read.
 * @returns each decoded frame, in order.
 * @throws Error when the response carries no body to read.
 */
export async function* readSseFrames<T>(
  response: Response,
  onMissingBody: (status: number) => Error
): AsyncGenerator<T, void, undefined> {
  if (!response.body) throw onMissingBody(response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // The last element is whatever came after the final newline — a partial
      // frame the next read completes. Yielding it would emit half a JSON
      // object as malformed and lose the whole frame.
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          yield JSON.parse(data) as T;
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
