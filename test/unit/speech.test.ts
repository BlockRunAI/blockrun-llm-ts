import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpeechClient } from "../../src/speech";
import { TEST_PRIVATE_KEY } from "../helpers/testHelpers";

const SPEECH_RESPONSE = {
  created: 1749000000,
  model: "elevenlabs/flash-v2.5",
  data: [
    { url: "https://cdn.example.com/speech.mp3", format: "mp3", characters: 20 },
  ],
};

const SOUNDFX_RESPONSE = {
  created: 1749000000,
  model: "elevenlabs/sound-effects",
  data: [{ url: "https://cdn.example.com/fx.mp3", format: "mp3" }],
};

describe("SpeechClient", () => {
  describe("Constructor", () => {
    it("should create client with valid private key", () => {
      const client = new SpeechClient({ privateKey: TEST_PRIVATE_KEY });
      expect(client).toBeDefined();
      expect(client.getWalletAddress().startsWith("0x")).toBe(true);
      expect(client.getWalletAddress().length).toBe(42);
    });

    it("should throw on missing private key", () => {
      const saved = {
        wallet: process.env.BLOCKRUN_WALLET_KEY,
        base: process.env.BASE_CHAIN_WALLET_KEY,
      };
      delete process.env.BLOCKRUN_WALLET_KEY;
      delete process.env.BASE_CHAIN_WALLET_KEY;
      try {
        expect(() => new SpeechClient({})).toThrow("Private key required");
      } finally {
        if (saved.wallet) process.env.BLOCKRUN_WALLET_KEY = saved.wallet;
        if (saved.base) process.env.BASE_CHAIN_WALLET_KEY = saved.base;
      }
    });

    it("should throw on invalid private key format", () => {
      expect(
        () => new SpeechClient({ privateKey: "invalid" as any })
      ).toThrow("must start with 0x");
    });
  });

  describe("getSpending", () => {
    it("should return initial zero spending", () => {
      const client = new SpeechClient({ privateKey: TEST_PRIVATE_KEY });
      const spending = client.getSpending();
      expect(spending.totalUsd).toBe(0);
      expect(spending.calls).toBe(0);
    });
  });

  describe("requests", () => {
    let client: SpeechClient;
    let fetchSpy: any;

    beforeEach(() => {
      client = new SpeechClient({ privateKey: TEST_PRIVATE_KEY });
      fetchSpy = vi.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("generate() posts to /v1/audio/speech with defaults", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => SPEECH_RESPONSE,
      });

      const result = await client.generate("Welcome to BlockRun.");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://blockrun.ai/api/v1/audio/speech");
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        model: "elevenlabs/flash-v2.5",
        input: "Welcome to BlockRun.",
      });
      expect(result.data[0].url).toBe("https://cdn.example.com/speech.mp3");
      expect(result.data[0].characters).toBe(20);
    });

    it("generate() maps options to snake_case fields", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => SPEECH_RESPONSE,
      });

      await client.generate("Breaking news.", {
        model: "elevenlabs/v3",
        voice: "george",
        responseFormat: "wav",
        speed: 1.1,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toEqual({
        model: "elevenlabs/v3",
        input: "Breaking news.",
        voice: "george",
        response_format: "wav",
        speed: 1.1,
      });
    });

    it("speak() is an alias for generate()", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => SPEECH_RESPONSE,
      });

      const result = await client.speak("Hello");
      expect(fetchSpy.mock.calls[0][0]).toBe(
        "https://blockrun.ai/api/v1/audio/speech"
      );
      expect(result.model).toBe("elevenlabs/flash-v2.5");
    });

    it("soundEffect() posts to /v1/audio/sound-effects", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => SOUNDFX_RESPONSE,
      });

      const result = await client.soundEffect("rain on a tin roof", {
        durationSeconds: 5,
        promptInfluence: 0.7,
      });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://blockrun.ai/api/v1/audio/sound-effects");
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        model: "elevenlabs/sound-effects",
        text: "rain on a tin roof",
        duration_seconds: 5,
        prompt_influence: 0.7,
      });
      expect(result.data[0].url).toBe("https://cdn.example.com/fx.mp3");
    });

    it("listVoices() gets /v1/audio/voices and unwraps data", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          object: "list",
          data: [
            { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", alias: "sarah" },
            { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George", alias: "george" },
          ],
        }),
      });

      const voices = await client.listVoices();

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://blockrun.ai/api/v1/audio/voices");
      expect(init.method).toBe("GET");
      expect(voices).toHaveLength(2);
      expect(voices[0].alias).toBe("sarah");
      expect(voices[1].voice_id).toBe("JBFqnCBsd6RMkjVDRZzb");
    });
  });
});
