import { Result } from "better-result";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  decryptAIConfig,
  type OrgAIConfigReadFailure,
  unreadableOrgAIConfig,
} from "@/api/lib/ai-config-crypto";
import {
  loadOrgAIConfig,
  loadOrgAISettings,
  loadOrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import {
  decryptOrgAIConfigRow,
  resolvePromptCachingPreference,
} from "@/api/lib/ai-config-loader-core";
import * as captureModule from "@/api/lib/analytics/capture";
import { toSafeId } from "@/api/lib/branded-types";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { assertSettingsFailureConfidential } from "@/api/tests/helpers/settings-failure-confidentiality";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
const userId = toSafeId<"user">("user_loader_test");

type SettingsRow = {
  aiConfigEncrypted: Buffer | null;
  aiConfigIv: Buffer | null;
  promptCachingEnabled: boolean;
  managedAIResidency: "eu";
};

const settingsReader = (row: SettingsRow) => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [row] }),
      }),
    }),
    transaction: async <T>(run: (tx: unknown) => Promise<T>) => await run(db),
  };
  return asTestRaw<Parameters<typeof loadOrgAIConfig>[0]>(db);
};

describe("loadOrgAIConfig", () => {
  test("every runtime loader exposes only the shared confidentiality allowlist", async () => {
    const key = envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY;
    const fixtures = {
      "incomplete-envelope": {
        aiConfigEncrypted: Buffer.from("stored-incomplete"),
        aiConfigIv: null,
      },
      "missing-key": {
        aiConfigEncrypted: Buffer.from("stored-missing-key"),
        aiConfigIv: Buffer.alloc(12, 21),
      },
      "decryption-failed": {
        aiConfigEncrypted: Buffer.from("stored-decryption"),
        aiConfigIv: Buffer.alloc(12, 22),
      },
      "invalid-json": {
        aiConfigEncrypted: Buffer.from('{"secret":'),
        aiConfigIv: Buffer.alloc(12),
      },
      "invalid-schema": {
        aiConfigEncrypted: Buffer.from(
          JSON.stringify({ providers: [{ apiKey: "stored-secret" }] }),
        ),
        aiConfigIv: Buffer.alloc(12),
      },
    } as const satisfies Record<
      OrgAIConfigReadFailure,
      { aiConfigEncrypted: Buffer; aiConfigIv: Buffer | null }
    >;
    const loaders = {
      loadOrgAIConfig,
      loadOrgAISettings,
      loadOrgSettingsForAuth,
    } as const;
    const isReason = (value: string): value is keyof typeof fixtures =>
      Object.hasOwn(fixtures, value);

    try {
      for (const reason of Object.keys(fixtures)) {
        if (!isReason(reason)) {
          continue;
        }
        envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY =
          reason === "missing-key" ? undefined : key;
        for (const [name, load] of Object.entries(loaders)) {
          const analytics = installRecordingAnalytics();
          const logs = installRecordingLogger();
          const capture = spyOn(captureModule, "captureObservedError");
          const devErrors = spyOn(console, "error").mockImplementation(
            () => undefined,
          );
          try {
            const row = {
              ...fixtures[reason],
              promptCachingEnabled: false,
              managedAIResidency: "eu" as const,
            };
            const result = await load(settingsReader(row), {
              organizationId,
              userId,
            });
            let returned: unknown = result;
            if (name !== "loadOrgSettingsForAuth" && "error" in result) {
              returned = result.error;
            }
            assertSettingsFailureConfidential({
              reason,
              organizationId,
              outputs: {
                analyticsEvents: analytics.events,
                captureEntries: capture.mock.calls,
                developmentEntries: devErrors.mock.calls,
                groupIdentifies: analytics.groupIdentifies,
                logRecords: logs.records,
                returned,
              },
            });
          } finally {
            devErrors.mockRestore();
            capture.mockRestore();
            logs.restore();
            analytics.restore();
          }
        }
      }
    } finally {
      envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY = key;
    }
  });

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
    expect(result.error).toMatchObject({
      _tag: "OrgAIConfigReadError",
      message: "Decrypted organization AI configuration is unreadable",
      name: "OrgAIConfigReadError",
      reason: "decryption-failed",
    });
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
      const analytics = installRecordingAnalytics();
      const capture = spyOn(captureModule, "captureObservedError");
      const devErrors = spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      try {
        const error = unreadableOrgAIConfig(organizationId, classifiedReason);
        assertSettingsFailureConfidential({
          reason: classifiedReason,
          organizationId,
          outputs: {
            analyticsEvents: analytics.events,
            captureEntries: capture.mock.calls,
            developmentEntries: devErrors.mock.calls,
            groupIdentifies: analytics.groupIdentifies,
            logRecords: logger.records,
            returned: error,
          },
        });
      } finally {
        devErrors.mockRestore();
        capture.mockRestore();
        analytics.restore();
        logger.restore();
      }
    }
  });

  test("the covered reader inventory owns every encrypted settings read", async () => {
    const boundaryCallers: string[] = [];
    for await (const file of new Bun.Glob("src/**/*.ts").scan(".")) {
      if (file.endsWith(".test.ts") || file.includes("/tests/")) {
        continue;
      }
      const source = await Bun.file(file).text();
      const callsCryptoBoundary =
        file !== "src/lib/ai-config-crypto.ts" &&
        /\bdecryptAIConfig\s*\(/u.test(source);
      const callsRowBoundary =
        file !== "src/lib/ai-config-loader-core.ts" &&
        /\bdecryptOrgAIConfigRow\s*\(/u.test(source);
      if (callsCryptoBoundary || callsRowBoundary) {
        boundaryCallers.push(file);
      }
    }
    expect(boundaryCallers.toSorted()).toEqual([
      "src/handlers/organization-settings/read-ai-config.ts",
      "src/handlers/organization-settings/update-ai-config.ts",
      "src/lib/ai-config-loader.ts",
    ]);
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
