import { describe, expect, test } from "bun:test";

import { createProviderCredentialDraft } from "@/components/ai-config-role-models.logic";

process.env["VITE_API_URL"] ??= "https://api.example.test";
const { createProviderPreview } =
  await import("@/routes/onboarding/-components/steps/ai-step");

const idleRowStates = {
  google: { status: "idle" },
  anthropic: { status: "idle" },
  openai: { status: "idle" },
  openrouter: { status: "idle" },
  mistral: { status: "idle" },
  bedrock: { status: "idle" },
} as const;

describe("AI provider preview", () => {
  test("publishes only actionable or confirmed provider rows", () => {
    const google = createProviderCredentialDraft("google");
    const openai = createProviderCredentialDraft("openai");

    expect(
      createProviderPreview([google, openai], {
        ...idleRowStates,
        google: { status: "checking", savedKey: "google-key" },
        openai: { status: "valid", savedKey: "openai-key" },
      }),
    ).toEqual([
      { provider: "google", status: "checking" },
      { provider: "openai", status: "valid" },
    ]);
  });

  test("treats a stored masked credential as confirmed", () => {
    const google = {
      ...createProviderCredentialDraft("google"),
      apiKeyMasked: "••••1234",
    };

    expect(createProviderPreview([google], idleRowStates)).toEqual([
      { provider: "google", status: "valid" },
    ]);
  });
});
