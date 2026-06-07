import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VideoClient } from "../../src/video";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

describe("VideoClient generate() input validation", () => {
  let client: VideoClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new VideoClient({ privateKey: TEST_PRIVATE_KEY });
    // generate() validates before any network call; spy on fetch so an
    // accidental fall-through never hits the wire.
    fetchSpy = vi.spyOn(global, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockRejectedValue(new Error("network call not expected"));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("rejects imageUrl + realFaceAssetId", async () => {
    await expect(
      client.generate("x", {
        imageUrl: "https://example.com/a.jpg",
        realFaceAssetId: "ta_abc123",
      })
    ).rejects.toThrow("mutually exclusive");
  });

  it("rejects lastFrameUrl without imageUrl", async () => {
    await expect(
      client.generate("x", { lastFrameUrl: "https://example.com/last.jpg" })
    ).rejects.toThrow("requires imageUrl");
  });

  it("rejects lastFrameUrl + realFaceAssetId", async () => {
    await expect(
      client.generate("x", {
        imageUrl: "https://example.com/first.jpg",
        lastFrameUrl: "https://example.com/last.jpg",
        realFaceAssetId: "ta_abc123",
      })
    ).rejects.toThrow("mutually exclusive");
  });

  it("rejects referenceImageUrls combined with other image inputs", async () => {
    await expect(
      client.generate("x", {
        imageUrl: "https://example.com/seed.jpg",
        referenceImageUrls: ["https://example.com/r.jpg"],
      })
    ).rejects.toThrow("mutually exclusive");
    await expect(
      client.generate("x", {
        realFaceAssetId: "ta_abc123",
        referenceImageUrls: ["https://example.com/r.jpg"],
      })
    ).rejects.toThrow("mutually exclusive");
  });

  it("rejects more than 9 referenceImageUrls", async () => {
    await expect(
      client.generate("x", {
        referenceImageUrls: Array.from(
          { length: 10 },
          (_, i) => `https://example.com/${i}.jpg`
        ),
      })
    ).rejects.toThrow("at most 9");
  });

  it("rejects malformed realFaceAssetId", async () => {
    await expect(
      client.generate("x", { realFaceAssetId: "portrait-123" })
    ).rejects.toThrow("ta_");
  });

  it("maps new params to snake_case body fields", async () => {
    // Intercept the submit POST and inspect the body, then bail out with a
    // recognizable error so we don't exercise the poll loop.
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.image_url).toBe("https://example.com/bud.jpg");
      expect(body.last_frame_url).toBe("https://example.com/bloom.jpg");
      throw new Error("stop-after-body-check");
    });

    await expect(
      client.generate("the flower blooms", {
        model: "bytedance/seedance-1.5-pro",
        imageUrl: "https://example.com/bud.jpg",
        lastFrameUrl: "https://example.com/bloom.jpg",
      })
    ).rejects.toThrow("stop-after-body-check");

    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.reference_image_urls).toEqual([
        "https://example.com/character.jpg",
        "https://example.com/city.jpg",
      ]);
      expect(body.image_url).toBeUndefined();
      throw new Error("stop-after-body-check");
    });

    await expect(
      client.generate("the character from image 1 in the city from image 2", {
        model: "bytedance/seedance-2.0",
        referenceImageUrls: [
          "https://example.com/character.jpg",
          "https://example.com/city.jpg",
        ],
      })
    ).rejects.toThrow("stop-after-body-check");
  });
});
