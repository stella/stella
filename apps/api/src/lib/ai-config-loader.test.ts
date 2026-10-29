import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  decryptAIConfig,
  type OrgAIConfigReadFailure,
  unreadableOrgAIConfig,
} from "@/api/lib/ai-config-crypto";
import {
  decryptOrgAIConfigRow,
  resolvePromptCachingPreference,
} from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const descriptorGraph = (value: unknown, seen = new Set<object>()): unknown => {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return value;
  }
  if (seen.has(value)) {
    return "[cycle]";
  }
  seen.add(value);
  return Reflect.ownKeys(value).map((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return {
      key: String(key),
      configurable: descriptor?.configurable,
      enumerable: descriptor?.enumerable,
      writable:
        descriptor && "writable" in descriptor
          ? descriptor.writable
          : undefined,
      value:
        descriptor && "value" in descriptor
          ? descriptorGraph(descriptor.value, seen)
          : "[accessor]",
    };
  });
};

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
    expect(JSON.stringify(descriptorGraph(result.error))).not.toContain(marker);
    expect(Object.hasOwn(result.error, "cause")).toBe(false);
    expect(Object.hasOwn(result.error, "metadata")).toBe(false);
  });

  test("emits one bounded diagnostic for every classified failure", () => {
    const logger = installRecordingLogger();
    const reasons = [
      "missing-key",
      "decryption-failed",
      "incomplete-envelope",
      "invalid-json",
      "invalid-schema",
    ] as const satisfies readonly OrgAIConfigReadFailure[];

    try {
      for (const reason of reasons) {
        const error = unreadableOrgAIConfig(organizationId, reason);
        expect(descriptorGraph(error)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: "message",
              value: "Decrypted organization AI configuration is unreadable",
            }),
            expect.objectContaining({ key: "reason", value: reason }),
          ]),
        );
        expect(Object.hasOwn(error, "cause")).toBe(false);
      }

      expect(logger.records).toHaveLength(reasons.length);
      expect(
        logger.records.map(({ message, attributes }) => ({
          message,
          attributes,
        })),
      ).toEqual(
        reasons.map((reason) => ({
          message: "organization_ai_config.read_failed",
          attributes: {
            action: "decrypt",
            organizationId,
            reason,
            source: "organization_ai_config",
          },
        })),
      );
    } finally {
      logger.restore();
    }
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
