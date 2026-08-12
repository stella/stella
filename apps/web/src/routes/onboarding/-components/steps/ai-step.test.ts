import { describe, expect, test } from "bun:test";

import { createProviderCredentialDraft } from "@/components/ai-config-role-models.logic";
import { createProviderPreview } from "@/routes/onboarding/-components/steps/ai-step.logic";
import type { RowState } from "@/routes/onboarding/-components/steps/ai-step.logic";

const idleRowStates = {
  google: { status: "idle" },
  anthropic: { status: "idle" },
  openai: { status: "idle" },
  openrouter: { status: "idle" },
  mistral: { status: "idle" },
  bedrock: { status: "idle" },
} as const;

describe("AI provider preview", () => {
  test("binds key fingerprints to validation states", () => {
    const fingerprintedStates = [
      { status: "checking", savedKey: "checking-key" },
      { status: "valid", savedKey: "valid-key" },
      { status: "invalid", savedKey: "invalid-key" },
    ] as const satisfies readonly RowState[];

    // @ts-expect-error - a validation result must identify the key it checked.
    const missingFingerprint: RowState = { status: "valid" };
    // @ts-expect-error - idle rows must not retain a stale validated fingerprint.
    const staleFingerprint: RowState = { status: "idle", savedKey: "stale" };

    expect(
      fingerprintedStates.every((state) => state.savedKey.length > 0),
    ).toBe(true);
    void missingFingerprint;
    void staleFingerprint;
  });

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
