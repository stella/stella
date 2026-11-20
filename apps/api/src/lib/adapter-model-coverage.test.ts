import { GEMINI_MODELS } from "@tanstack/ai-gemini";
import { OPENAI_CHAT_MODELS } from "@tanstack/ai-openai";
import { OPENROUTER_CHAT_MODELS } from "@tanstack/ai-openrouter/model-meta";
import { describe, expect, test } from "bun:test";

import { BYOK_MODEL_OPTIONS } from "@stll/ai-catalog";

/**
 * An adapter treats a model it does not list as unknown: it drops reasoning
 * settings and, for OpenAI, keeps sampling parameters a reasoning model
 * rejects. Every offered model must be listed, by upstream or by our patch
 * in patches/ that clones a sibling's metadata.
 */
const ADAPTER_MODELS = {
  google: GEMINI_MODELS,
  openai: OPENAI_CHAT_MODELS,
  openrouter: OPENROUTER_CHAT_MODELS,
} as const;
const PROVIDERS = ["google", "openai", "openrouter"] as const;
type Provider = (typeof PROVIDERS)[number];

/** Offered IDs an adapter may leave unlisted, each with the reason. */
const REVIEWED_UNLISTED: readonly {
  provider: Provider;
  modelId: string;
  reason: string;
}[] = [
  {
    provider: "openai",
    modelId: "gpt-5.6",
    reason: "OpenAI alias of gpt-5.6-sol, which the adapter lists.",
  },
  {
    provider: "openai",
    modelId: "gpt-5.4",
    reason: "Older generation kept for existing selections.",
  },
];

const offered = (provider: Provider): readonly string[] =>
  BYOK_MODEL_OPTIONS[provider];
const listed = (provider: Provider): readonly string[] =>
  ADAPTER_MODELS[provider];

describe("adapter model coverage", () => {
  test("every offered model is known to its adapter", () => {
    const unlisted = PROVIDERS.flatMap((provider) =>
      offered(provider)
        .filter((modelId) => !listed(provider).includes(modelId))
        .filter(
          (modelId) =>
            !REVIEWED_UNLISTED.some(
              (gap) => gap.provider === provider && gap.modelId === modelId,
            ),
        )
        .map((modelId) => `${provider}:${modelId}`),
    );
    expect(unlisted).toEqual([]);
  });

  test("every reviewed gap is still offered and still unlisted", () => {
    const stale = REVIEWED_UNLISTED.filter(
      ({ provider, modelId }) =>
        !offered(provider).includes(modelId) ||
        listed(provider).includes(modelId),
    ).map(({ provider, modelId }) => `${provider}:${modelId}`);
    expect(stale).toEqual([]);
  });
});
