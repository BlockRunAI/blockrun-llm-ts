import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicClient } from "../../src/music";
import { APIError } from "../../src/types";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

const AMOUNT = "200000";
const POLL_URL = "/api/v1/audio/generations/job-1";
const TRACK = { created: 1, model: "minimax/music-2.5+", data: [{ url: "https://cdn.example/track.mp3" }] };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const challenge = () =>
  json(402, {
    x402Version: 2,
    resource: { url: "https://blockrun.ai/api/v1/audio/generations", description: "music", mimeType: "application/json" },
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      amount: AMOUNT,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xe9030014F5DAe217d0A152f02A043567b16c1aBf",
      maxTimeoutSeconds: 600,
      extra: { name: "USD Coin", version: "2" },
    }],
  });
const pointer = () => json(202, { id: "job-1", status: "queued", poll_url: POLL_URL });

/** Stubs fetch with these responses in order, and runs generate() to its end. */
async function generate(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
    else fetchMock.mockResolvedValueOnce(r);
  }
  vi.stubGlobal("fetch", fetchMock);
  const client = new MusicClient({ privateKey: TEST_PRIVATE_KEY });
  const settled = client.generate("calm piano").then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await vi.advanceTimersByTimeAsync(400_000);
  return { ...(await settled), fetchMock, client };
}

describe("MusicClient: a slow track answers 202 + poll_url", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls until the track is ready, instead of returning the pointer as a result", async () => {
    const { value, error, fetchMock } = await generate(
      challenge(),
      pointer(),
      json(202, { id: "job-1", status: "in_progress" }),
      json(200, { ...TRACK, status: "completed" }, { "x-payment-receipt": "0xtx" }),
    );
    expect(error).toBeUndefined();
    expect(value!.data[0].url).toBe(TRACK.data[0].url);
    expect(value!.txHash).toBe("0xtx");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("polls the gateway's URL with the same signature that paid for the job", async () => {
    const { fetchMock } = await generate(challenge(), pointer(), json(200, TRACK));
    const signature = fetchMock.mock.calls[1][1].headers["PAYMENT-SIGNATURE"];
    expect(signature).toBeTruthy();
    expect(fetchMock.mock.calls[2][0]).toBe(`https://blockrun.ai${POLL_URL}`);
    expect(fetchMock.mock.calls[2][1].method).toBe("GET");
    expect(fetchMock.mock.calls[2][1].headers["PAYMENT-SIGNATURE"]).toBe(signature);
  });

  it("books the signed amount only once the track arrives", async () => {
    const { client } = await generate(challenge(), pointer(), json(200, TRACK));
    expect(client.getSpending()).toEqual({ totalUsd: 0.2, calls: 1 });
  });

  it("books nothing when the job fails, which charged nothing", async () => {
    const { error, client } = await generate(challenge(), pointer(), json(200, { status: "failed", error: "upstream refused" }));
    expect(error).toBeInstanceOf(APIError);
    expect((error as Error).message).toContain("upstream refused");
    expect(client.getSpending().calls).toBe(0);
  });

  it("keeps polling through a dropped connection and gateway errors, so a paid track is not lost", async () => {
    const { value, error } = await generate(
      challenge(),
      pointer(),
      new Error("socket hang up"),
      json(503, { error: "unavailable" }),
      json(504, { error: "timeout" }),
      json(200, { ...TRACK, payment: { status: "already_settled", tx_hash: "0xfirst" } }),
    );
    expect(error).toBeUndefined();
    expect(value!.txHash).toBe("0xfirst");
  });

  it("stops on a refusal and names the job, so the caller doesn't pay again blind", async () => {
    const { error } = await generate(challenge(), pointer(), json(403, { error: "Payment payer mismatch" }));
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).statusCode).toBe(403);
    expect((error as Error).message).toContain(POLL_URL);
  });

  it("gives up at the deadline, naming the job and warning against paying again", async () => {
    const fetchMock = vi.fn(async () => json(202, { id: "job-1", status: "in_progress" }));
    fetchMock.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(pointer());
    vi.stubGlobal("fetch", fetchMock);
    const client = new MusicClient({ privateKey: TEST_PRIVATE_KEY });
    const settled = client.generate("calm piano").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(400_000);
    const error = (await settled) as APIError;
    expect(error).toBeInstanceOf(APIError);
    expect(error.statusCode).toBe(504);
    expect(error.message).toContain("before paying again");
    expect(JSON.stringify(error.response)).toContain(POLL_URL);
  });

  it("rejects a 202 with nothing to poll", async () => {
    const { error } = await generate(challenge(), json(202, { id: "job-1", status: "queued" }));
    expect(error).toBeInstanceOf(APIError);
    expect((error as Error).message).toContain("no poll_url");
  });

  it("still returns an inline track directly", async () => {
    const { value, fetchMock } = await generate(challenge(), json(200, TRACK, { "x-payment-receipt": "0xinline" }));
    expect(value!.txHash).toBe("0xinline");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
