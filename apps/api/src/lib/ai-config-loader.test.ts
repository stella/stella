import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import {
  decryptOrgAIConfigRow,
  resolvePromptCachingPreference,
} from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";

const ownErrorText = (error: object) =>
  Reflect.ownKeys(error)
    .map((key) => String(Reflect.getOwnPropertyDescriptor(error, key)?.value))
    .join(" ");

beforeEach(() => {
  decryptAIConfigMock.mockClear();
});

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
  decision: null,
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
      decrypt: decryptAIConfig,
      organizationId,
      row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: null },
    });
    const missingCiphertext = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfig,
      organizationId,
      row: { aiConfigEncrypted: null, aiConfigIv: "\\x0102" },
    });

    expect(missingIv.status).toBe("corrupt");
    expect(missingCiphertext.status).toBe("corrupt");
    if (
      missingIv.status !== "corrupt" ||
      missingCiphertext.status !== "corrupt"
    ) {
      throw new Error("Expected incomplete envelopes to be corrupt");
    }
    expect(missingIv.error.reason).toBe("incomplete-envelope");
    expect(missingCiphertext.error.reason).toBe("incomplete-envelope");
    expect(decryptAIConfigMock).not.toHaveBeenCalled();
  });

  test("reports a corrupt row instead of throwing, for degrade-capable callers", async () => {
    const marker = "marker-secret-from-provider-settings";
    const decryptError = Object.assign(
      new Error(marker, {
        cause: Object.assign(new Error(marker), { nested: marker }),
      }),
      { metadata: marker },
    );
    const decrypt = mock(async () => {
      throw decryptError;
    });

    const result = await decryptOrgAIConfigRow({
      decrypt,
      organizationId,
      row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: "\\x0102" },
    });

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") {
      throw new Error("Expected decryption failure to be corrupt");
    }
    expect(result.error.reason).toBe("decryption-failed");
    expect(ownErrorText(result.error)).not.toContain(marker);
    expect(Object.hasOwn(result.error, "cause")).toBe(false);
    expect(Object.hasOwn(result.error, "metadata")).toBe(false);
  });
});

describe("resolvePromptCachingPreference", () => {
  test("defaults to enabled when settings are absent", async () => {
    expect(resolvePromptCachingPreference(undefined)).toBe(true);
  });

  test("returns the stored preference", async () => {
    expect(
      resolvePromptCachingPreference({ promptCachingEnabled: false }),
    ).toBe(false);
  });
});
