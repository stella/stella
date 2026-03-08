/**
 * Centralized AI model registry.
 *
 * All model IDs live here so upgrades and deprecations
 * are a single-line change. Each constant documents which
 * capabilities the call-site depends on.
 *
 * Model IDs use the OpenRouter naming convention
 * ("provider/model"). When calling the Google SDK directly,
 * strip the "google/" prefix.
 */

import { google } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { env } from "@/api/env";

/**
 * Fast, cheap model for structured output tasks:
 * classification, extraction, short generation.
 *
 * Capabilities relied on: structured output (JSON mode),
 * multilingual (cs/sk/pl/de), low latency.
 */
export const FAST_MODEL = "google/gemini-3-flash-preview";

/**
 * Model with native PDF/image understanding for
 * document processing: bounding boxes, OCR, layout.
 *
 * Capabilities relied on: PDF file input, spatial
 * reasoning, bounding box coordinate output.
 */
export const PDF_NATIVE_MODEL = "google/gemini-3-flash-preview";

/**
 * Conversational model for the chat actor.
 *
 * Capabilities relied on: tool use, streaming,
 * multilingual, long context, conversational tone.
 */
export const CHAT_MODEL = "google/gemini-3-flash-preview";

/**
 * Reasoning model for complex multi-step tasks:
 * legal analysis, document editing, comparison, strategy.
 *
 * Capabilities relied on: advanced reasoning, long context,
 * structured output, multilingual. Higher latency and cost
 * than FAST_MODEL; use only where reasoning depth matters.
 */
export const REASONING_MODEL = "google/gemini-3-pro-preview";

/** Strip the "google/" prefix for direct Google SDK calls. */
const GOOGLE_PREFIX = /^google\//;
const googleModelId = (model: string) => model.replace(GOOGLE_PREFIX, "");

/** Lazily created OpenRouter client (reused across calls). */
const openrouter = env.OPENROUTER_API_KEY
  ? createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })
  : null;

/**
 * Get a Vercel AI SDK model instance.
 *
 * Uses OpenRouter when an API key is configured,
 * otherwise falls back to the Google AI SDK directly.
 */
export const getModel = (model: string) =>
  openrouter ? openrouter.chat(model) : google(googleModelId(model));
