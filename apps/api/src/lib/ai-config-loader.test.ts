import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  decryptOrgAIConfigRow,
  resolvePromptCachingPreference,
} from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { toSafeId } from "@/api/lib/branded-types";

const decryptedAIConfig: OrgAIConfig = {
  providers: [
    {
      apiKey: "org-google-secret",
      provider: "google",
    },
  ],
  overrideModels: {
    chat: { provider: "google", modelId: "gemini-3.5-flash" },
    fast: { provider: "google", modelId: "gemini-3.5-flash" },
    pdf: { provider: "google", modelId: "gemini-3.5-flash" },
    reasoning: { provider: "google", modelId: "gemini-3.1-pro-preview" },
  },
};

const decryptAIConfigMock = mock(async () => decryptedAIConfig);

beforeEach(() => {
  decryptAIConfigMock.mockClear();
});

const organizationId = toSafeId<"organization">("org_loader_test");

describe("loadOrgAIConfig", () => {
  test("returns null for nullish encrypted settings", async () => {
    const result = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfigMock,
      organizationId,
      row: { aiConfigEncrypted: null, aiConfigIv: undefined },
    });

    expect(result).toBeNull();
    expect(decryptAIConfigMock).not.toHaveBeenCalled();
  });

  test("decodes bytea text before decrypting", async () => {
    const result = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfigMock,
      organizationId,
      row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: "\\x0102" },
    });

    expect(result).toEqual(decryptedAIConfig);
    expect(decryptAIConfigMock).toHaveBeenCalledWith(
      organizationId,
      Buffer.from([10, 11]),
      Buffer.from([1, 2]),
    );
  });
});

describe("loadPromptCachingPreference", () => {
  test("defaults to enabled when settings are absent", async () => {
    expect(resolvePromptCachingPreference(undefined)).toBe(true);
  });

  test("returns the stored preference", async () => {
    expect(
      resolvePromptCachingPreference({ promptCachingEnabled: false }),
    ).toBe(false);
  });
});
