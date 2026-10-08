import { describe, expect, test } from "bun:test";

import {
  PROVIDER_SETUP_ERROR_CATALOGUE,
  PROVIDER_SETUP_ERROR_CODE,
} from "@stll/api-contract/provider-setup";

import { PROVIDER_SETUP_ERROR_FIXTURES as fixtures } from "@/api/tests/fixtures/provider-setup-errors";

import { identifyProviderSetupError } from "./provider-error-catalogue";

describe("provider setup error catalogue", () => {
  for (const code of Object.values(PROVIDER_SETUP_ERROR_CODE)) {
    test(`identifies the recorded ${code} response and supplies a fix`, () => {
      expect(identifyProviderSetupError(fixtures[code])).toBe(code);
      const guidance = PROVIDER_SETUP_ERROR_CATALOGUE[code];
      expect(guidance.field).toBeTruthy();
      expect(new URL(guidance.url).protocol).toBe("https:");
    });
  }

  test("matches the workspace error documented by the provider", () => {
    expect(
      identifyProviderSetupError({
        provider: "anthropic",
        error: {
          type: "invalid_request_error",
          message:
            "anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in.",
        },
      }),
    ).toBe(PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired);
  });

  test("does not reinterpret unknown codes or other providers", () => {
    const workspace =
      fixtures[PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired];
    expect(
      identifyProviderSetupError({
        ...workspace,
        error: { ...workspace.error, code: "different_error" },
      }),
    ).toBeUndefined();
    expect(
      identifyProviderSetupError({ ...workspace, provider: "openai" }),
    ).toBeUndefined();
    expect(
      identifyProviderSetupError({
        provider: "anthropic",
        error: {
          type: "invalid_request_error",
          message: "Other invalid request",
        },
      }),
    ).toBeUndefined();
  });
});

test("structured provider codes win over translated diagnostic messages", () => {
  for (const [code, fixture] of Object.entries(fixtures)) {
    if (
      fixture.provider === "anthropic" &&
      (code === PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired ||
        code === PROVIDER_SETUP_ERROR_CODE.anthropicKeyDisabled ||
        code === PROVIDER_SETUP_ERROR_CODE.anthropicSubscriptionToken)
    ) {
      continue;
    }
    expect(
      identifyProviderSetupError({
        provider: fixture.provider,
        error: { ...fixture.error, message: "Translated diagnostic" },
      }),
    ).toBe(code);
  }
});

test("recognizes Google IP restrictions and ignores other structured reasons", () => {
  const error = {
    code: 403,
    message: "Diagnostic",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "API_KEY_IP_ADDRESS_BLOCKED",
      },
    ],
  };
  expect(identifyProviderSetupError({ provider: "google", error })).toBe(
    PROVIDER_SETUP_ERROR_CODE.googleKeyRestricted,
  );
  expect(
    identifyProviderSetupError({
      provider: "google",
      error: {
        ...error,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "OTHER_ERROR",
          },
        ],
      },
    }),
  ).toBeUndefined();
});
