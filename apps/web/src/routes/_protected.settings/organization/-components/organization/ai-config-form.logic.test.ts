import { expect, test } from "bun:test";

import {
  aiAvailableResponse,
  aiUnavailableResponse,
} from "@/__fixtures__/ai-availability";
import {
  createDecisionModelState,
  createProviderCredentialDraft,
} from "@/components/ai-config-role-models.logic";

import {
  canSaveAIConfig,
  deriveInitialAIConfig,
  providerModes,
  resolveProviderKeyNeed,
  sameProviderSet,
} from "./ai-config-form.logic";

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

test("an organization without keys starts with no provider rows", () => {
  expect(
    deriveInitialAIConfig({
      configured: false,
      defaultModels: {
        chat: null,
        fast: null,
        reasoning: null,
        pdf: null,
        browse: null,
      },
      providerDefaultModels: [],
      instanceProvisioned: true,
      decisionInstanceProvisioned: false,
      verificationDecisionModel: { enabled: false, available: false },
    }).providers,
  ).toEqual([]);
});

test.each([
  { configured: true, availability: undefined, expected: "ownKeys" },
  { configured: false, availability: undefined, expected: "unknown" },
  {
    configured: false,
    availability: aiAvailableResponse(),
    expected: "builtIn",
  },
  {
    configured: false,
    availability: aiUnavailableResponse(),
    expected: "keyRequired",
  },
  {
    configured: false,
    availability: aiUnavailableResponse({
      unavailableReason: "own_key_required",
    }),
    expected: "keyRequired",
  },
  {
    configured: false,
    availability: aiUnavailableResponse({
      unavailableReason: "member_assignment_required",
    }),
    expected: "unknown",
  },
  {
    configured: false,
    availability: aiUnavailableResponse({ unavailableReason: "unreadable" }),
    expected: "unknown",
  },
] as const)(
  "key need: configured , .unavailableReason -> ",
  ({ configured, availability, expected }) => {
    expect(resolveProviderKeyNeed({ configured, availability })).toBe(expected);
  },
);

test("a provider serves the modes whose model it supplies, in mode order", () => {
  const selections = {
    chat: { provider: "anthropic", modelId: "a" },
    fast: { provider: "google", modelId: "g" },
    reasoning: { provider: "anthropic", modelId: "a" },
    pdf: null,
    browse: null,
  } as const;
  expect(providerModes(selections, "anthropic")).toEqual(["chat", "reasoning"]);
  expect(providerModes(selections, "google")).toEqual(["fast"]);
  expect(providerModes(selections, "openai")).toEqual([]);
});

test("provider sets compare by provider, not order", () => {
  const google = createProviderCredentialDraft("google");
  const anthropic = createProviderCredentialDraft("anthropic");
  expect(sameProviderSet([google, anthropic], [anthropic, google])).toBe(true);
  expect(sameProviderSet([google], [google, anthropic])).toBe(false);
  expect(sameProviderSet([google], [anthropic])).toBe(false);
});
