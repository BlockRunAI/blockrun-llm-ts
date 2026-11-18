/**
 * Decisions — typed judgments, OpenAI Decisions-compatible (`POST /v1/decisions`).
 *
 * The caller sends evidence (`input`) and questions with a fixed answer space
 * (predicate, choice or score) and gets one typed answer per question back
 * instead of text. Served on every rail: x402 `exact` on Base, Arc and Solana,
 * batch settlement on Solana (metered on the input tokens the provider
 * reports), and an account API key on api.blockrun.ai.
 *
 * The gateway owns the limits (body size, 64 questions, 255 choices or levels,
 * 120K characters, 8 inline images, no hosted image URLs) and refuses an
 * over-limit request with a 400 before any payment. This module only checks
 * the shape a typed caller can still get wrong, so a malformed request fails
 * before anything is sent.
 */
import type { DecisionsRequest } from "./types";
import { withDisposition } from "./types";

/** The model OpenAI serves Decisions from; the gateway also accepts our catalog ids. */
export const DECISIONS_DEFAULT_MODEL = "gpt-6-luna";

const QUESTION_TYPES = new Set(["predicate", "choice", "score"]);

/**
 * Google's Decisions model. It needs a `description` string (empty is fine) on
 * every choice and every score level; the gateway refuses it with a 400 before
 * payment otherwise (probed on sol.blockrun.ai 2026-11-18).
 */
export const GEMINI_DECISIONS_MODEL = "gemini-decision-1";

function isGemini(model: string | undefined): boolean {
  return typeof model === "string" && model.trim().replace(/^google\//, "") === GEMINI_DECISIONS_MODEL;
}

function invalid(message: string): never {
  // Nothing was sent: safe to fix and resend.
  throw withDisposition(new Error(`decisions: ${message}`), "unpaid");
}

/**
 * The request body for `POST /v1/decisions`: the caller's request with
 * `model` defaulted, after a shape check. Throws an `"unpaid"` error on a
 * malformed request.
 */
export function buildDecisionsBody(request: DecisionsRequest): Record<string, unknown> {
  if (!request || typeof request !== "object") invalid("request must be an object");
  const { input, questions } = request;
  const emptyInput = typeof input === "string" ? input.length === 0 : !Array.isArray(input) || input.length === 0;
  if (emptyInput) invalid("input must be a non-empty string or a non-empty array of messages");
  if (!Array.isArray(questions) || questions.length === 0) invalid("questions must be a non-empty array");
  const names = new Set<string>();
  questions.forEach((q, i) => {
    if (!q || typeof q !== "object") invalid(`questions[${i}] must be an object`);
    if (!QUESTION_TYPES.has(q.type)) invalid(`questions[${i}].type must be "predicate", "choice" or "score"`);
    if (typeof q.name !== "string" || q.name.length === 0) invalid(`questions[${i}].name must be a non-empty string`);
    if (typeof q.instructions !== "string" || q.instructions.length === 0) {
      invalid(`questions[${i}].instructions must be a non-empty string`);
    }
    if (names.has(q.name)) invalid(`questions[${i}].name "${q.name}" is used twice; answers are keyed by name`);
    names.add(q.name);
    if (q.type === "choice" && (!Array.isArray(q.choices) || q.choices.length === 0)) {
      invalid(`questions[${i}] (choice) needs a non-empty choices array`);
    }
    if (q.type === "score" && (!Array.isArray(q.levels) || q.levels.length === 0)) {
      invalid(`questions[${i}] (score) needs a non-empty levels array, lowest first`);
    }
    if (isGemini(request.model) && (q.type === "choice" || q.type === "score")) {
      const key = q.type === "choice" ? "choices" : "levels";
      const items: unknown[] = (q.type === "choice" ? q.choices : q.levels) ?? [];
      items.forEach((item, j) => {
        if (!item || typeof item !== "object" || typeof (item as { description?: unknown }).description !== "string") {
          invalid(`questions[${i}].${key}[${j}].description must be a string for ${GEMINI_DECISIONS_MODEL} (it may be empty: "")`);
        }
      });
    }
  });
  return { ...request, model: request.model ?? DECISIONS_DEFAULT_MODEL };
}
