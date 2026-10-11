import { expect, test } from "bun:test";

import {
  createDecisionModelState,
  createProviderCredentialDraft,
} from "@/components/ai-config-role-models.logic";

import { canSaveAIConfig } from "./ai-config-form.logic";

test.each([
  { credential: "stored" },
  { credential: "new" },
  { credential: "replacement" },
  { credential: "blank" },
  { credential: "removed" },
])(
  "decision key reuse follows the current OpenAI credential: $credential",
  ({ credential }) => {
    const draft = createProviderCredentialDraft("openai");
    const providers =
      credential === "removed"
        ? [{ ...createProviderCredentialDraft("google"), apiKey: "key" }]
        : [
            {
              ...draft,
              apiKey:
                credential === "new" || credential === "replacement"
                  ? "key"
                  : "",
              apiKeyMasked:
                credential === "stored" || credential === "replacement"
                  ? "****"
                  : undefined,
              replacingKey: credential === "replacement",
            },
          ];
    const expected = credential !== "blank" && credential !== "removed";
    const decisionState = createDecisionModelState("openai");
    expect(
      canSaveAIConfig({
        providers,
        roleModels: {},
        decisionState,
        storedDecision: null,
      }),
    ).toBe(expected);
    expect(
      canSaveAIConfig({
        providers,
        roleModels: {},
        decisionState: { kind: "untouched" },
        storedDecision: {
          provider: "openai",
          modelId: "gpt-6-luna",
          region: "eu",
          apiKeyMasked: undefined,
        },
      }),
    ).toBe(expected);
  },
);
