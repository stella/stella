import { describe, expect, test } from "bun:test";

import {
  PROVIDER_SETUP_ERROR_CATALOGUE,
  PROVIDER_SETUP_ERROR_CODE,
} from "@stll/api-contract/provider-setup";
import type { ProviderSetupErrorCode } from "@stll/api-contract/provider-setup";

import { identifyProviderSetupError } from "./provider-error-catalogue";

const fixtures = {
  [PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired]: {
    provider: "anthropic",
    error: {
      type: "invalid_request_error",
      message:
        "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.",
    },
  },
} as const satisfies Record<
  ProviderSetupErrorCode,
  Parameters<typeof identifyProviderSetupError>[0]
>;

describe("provider setup error catalogue", () => {
  for (const code of Object.values(PROVIDER_SETUP_ERROR_CODE)) {
    test(`identifies the recorded ${code} response and supplies a fix`, () => {
      expect(identifyProviderSetupError(fixtures[code])).toBe(code);
      const guidance = PROVIDER_SETUP_ERROR_CATALOGUE[code];
      expect(guidance.field).toBe("anthropicWorkspaceId");
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
