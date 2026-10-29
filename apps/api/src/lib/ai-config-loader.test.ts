import { Result } from "better-result";
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
import { assertSettingsFailureConfidential } from "@/api/tests/helpers/settings-failure-confidentiality";

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

const decryptAIConfigMock = mock(async () => Result.ok(decryptedAIConfig));

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

  test("preserves the classified result without throwing", async () => {
    const classified = unreadableOrgAIConfig(
      organizationId,
      "decryption-failed",
    );
    const decrypt = mock(async () => Result.err(classified));

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
    expect(result.error).toBe(classified);
    expect(Object.hasOwn(result.error, "cause")).toBe(false);
    expect(Object.hasOwn(result.error, "metadata")).toBe(false);
  });

  test("emits only the allowlisted output for every classified failure", () => {
    const reasons = {
      "missing-key": true,
      "decryption-failed": true,
      "incomplete-envelope": true,
      "invalid-json": true,
      "invalid-schema": true,
    } as const satisfies Record<OrgAIConfigReadFailure, true>;
    const isReason = (value: string): value is keyof typeof reasons =>
      Object.hasOwn(reasons, value);

    for (const reason of Object.keys(reasons)) {
      if (!isReason(reason)) {
        continue;
      }
      const classifiedReason: OrgAIConfigReadFailure = reason;
      const logger = installRecordingLogger();
      try {
        const error = unreadableOrgAIConfig(organizationId, classifiedReason);
        assertSettingsFailureConfidential({
          reason: classifiedReason,
          organizationId,
          outputs: {
            analyticsEvents: [],
            captureEntries: [],
            developmentEntries: [],
            groupIdentifies: [],
            logRecords: logger.records,
            returned: error,
          },
        });
      } finally {
        logger.restore();
      }
    }
  });

  test("the covered reader inventory owns every encrypted settings read", async () => {
    const sourceFiles = [
      "src/lib/ai-config-loader.ts",
      "src/handlers/organization-settings/read-ai-config.ts",
      "src/handlers/organization-settings/update-ai-config.ts",
    ] as const;
    const coveredReaders = [
      "loadOrgAIConfig",
      "loadOrgAISettings",
      "loadOrgSettingsForAuth",
      "readAIConfig",
      "updateAIConfig",
    ] as const;
    const sources = await Promise.all(
      sourceFiles.map(async (file) => await Bun.file(file).text()),
    );
    expect(sources.join("\n").match(/aiConfigEncrypted/gu)?.length).toBe(8);
    for (const reader of coveredReaders) {
      expect(sources.join("\n")).toContain(reader);
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
