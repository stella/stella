import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Result } from "better-result";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  decryptOrgAIConfigRow,
  decryptOrgAIConfigRowOrThrow,
  resolvePromptCachingPreference,
} from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";

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
  test("returns ok/null for nullish encrypted settings", async () => {
    const result = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfigMock,
      organizationId,
      row: { aiConfigEncrypted: null, aiConfigIv: undefined },
    });

    expect(result).toEqual({ status: "ok", config: null });
    expect(decryptAIConfigMock).not.toHaveBeenCalled();
  });

  test("decodes bytea text before decrypting", async () => {
    const result = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfigMock,
      organizationId,
      row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: "\\x0102" },
    });

    expect(result).toEqual({ status: "ok", config: decryptedAIConfig });
    expect(decryptAIConfigMock).toHaveBeenCalledWith(
      organizationId,
      Buffer.from([10, 11]),
      Buffer.from([1, 2]),
    );
  });

  test("treats a row with ciphertext but no IV (or vice versa) as corrupt", async () => {
    const missingIv = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfigMock,
      organizationId,
      row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: null },
    });
    const missingCiphertext = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfigMock,
      organizationId,
      row: { aiConfigEncrypted: null, aiConfigIv: "\\x0102" },
    });

    expect(missingIv.status).toBe("corrupt");
    expect(missingCiphertext.status).toBe("corrupt");
    expect(decryptAIConfigMock).not.toHaveBeenCalled();
  });

  test("reports a corrupt row instead of throwing, for degrade-capable callers", async () => {
    const decryptError = new Error("invalid config");
    const decrypt = mock(async () => {
      throw decryptError;
    });

    const result = await decryptOrgAIConfigRow({
      decrypt,
      organizationId,
      row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: "\\x0102" },
    });

    expect(result).toEqual({ status: "corrupt", error: decryptError });
  });

  test("does not replace an invalid stored configuration with defaults", async () => {
    const decrypt = mock(async () => {
      throw new Error("invalid config");
    });

    const outcome = await Result.tryPromise(
      async () =>
        await decryptOrgAIConfigRowOrThrow({
          decrypt,
          organizationId,
          row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: "\\x0102" },
        }),
    );

    expect(Result.isError(outcome)).toBe(true);
    if (Result.isError(outcome)) {
      expect(outcome.error.cause).toBeInstanceOf(ConfigurationError);
    }
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
