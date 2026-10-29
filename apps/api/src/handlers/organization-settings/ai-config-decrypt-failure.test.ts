import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { OrgAIConfigReadFailure } from "@/api/lib/ai-config-crypto";
import { AI_CONFIG_UNREADABLE_ERROR_CODE } from "@/api/lib/ai-config-response";
import * as captureModule from "@/api/lib/analytics/capture";
import { toSafeId } from "@/api/lib/branded-types";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { assertSettingsFailureConfidential } from "@/api/tests/helpers/settings-failure-confidentiality";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import readAIConfig from "./read-ai-config";
import updateAIConfig from "./update-ai-config";

/**
 * A stored row that cannot be decrypted with the org's current key: a
 * non-zero IV (so the row is not the plaintext envelope) over bytes that fail
 * the AES-GCM tag. `decryptAIConfig` rejects on it exactly as it would in
 * production after a key rotation, so neither handler needs a module mock to
 * reach its decrypt-failure branch.
 */
const undecryptableRow = {
  aiConfigEncrypted: Buffer.from(
    "9f3c1a77e5b40d28cc6f01935ae2d4b8a71c5e6039f8d24b7ce013a5b6082f4d",
    "hex",
  ),
  aiConfigIv: Buffer.from("a1b2c3d4e5f60718293a4b5c", "hex"),
};

type UpdateContext = Parameters<typeof updateAIConfig.handler>[0];
type ReadContext = Parameters<typeof readAIConfig.handler>[0];

const updateBody = {
  providers: [{ provider: "google", apiKey: "test-google-key" }],
  overrideModels: {
    fast: { provider: "google", modelId: "gemini-3.5-flash" },
    chat: { provider: "google", modelId: "gemini-3.5-flash" },
    reasoning: { provider: "google", modelId: "gemini-3.1-pro-preview" },
    pdf: { provider: "google", modelId: "gemini-3.5-flash" },
  },
  decision: null,
};

const writeRejectingTx = asTestRaw<Transaction>({
  insert: () => {
    throw new Error("the stored AI config must not be overwritten");
  },
});

/**
 * Serves the settings row on the first operation. Both handlers read the row
 * first, so any later operation is the write path a decrypt failure has to
 * prevent; it runs against a transaction that refuses inserts.
 */
type SettingsRow = {
  aiConfigEncrypted: Buffer | null;
  aiConfigIv: Buffer | null;
  ignored?: string;
};

const createSettingsDb = (
  settingsRow: SettingsRow = undecryptableRow,
): {
  safeDb: SafeDb;
  operationCount: () => number;
} => {
  let operationCount = 0;
  const safeDb = asTestRaw<SafeDb>(
    async (operation: (tx: Transaction) => Promise<unknown>) => {
      operationCount += 1;
      return operationCount === 1
        ? Result.ok(settingsRow)
        : Result.ok(await operation(writeRejectingTx));
    },
  );
  return { safeDb, operationCount: () => operationCount };
};

describe("AI config handlers with an undecryptable stored config", () => {
  test("every reader exposes only the shared confidentiality allowlist", async () => {
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
        aiConfigEncrypted: Buffer.from('{"unexpected":"stored"}'),
        aiConfigIv: Buffer.alloc(12),
      },
    } as const satisfies Record<OrgAIConfigReadFailure, SettingsRow>;
    const isReason = (value: string): value is keyof typeof fixtures =>
      Object.hasOwn(fixtures, value);
    const organizationId = toSafeId<"organization">("org_test");

    try {
      for (const reason of Object.keys(fixtures)) {
        if (!isReason(reason)) {
          continue;
        }
        envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY =
          reason === "missing-key" ? undefined : key;
        for (const reader of ["read", "update"] as const) {
          const analytics = installRecordingAnalytics();
          const logs = installRecordingLogger();
          const capture = spyOn(captureModule, "captureObservedError");
          const devErrors = spyOn(console, "error").mockImplementation(
            () => undefined,
          );
          try {
            const db = createSettingsDb(fixtures[reason]);
            const returned =
              reader === "read"
                ? await readAIConfig.handler(
                    createTestHandlerContext<ReadContext>({
                      audit: NO_AUDIT,
                      scopedDb: NO_DB,
                      safeDb: db.safeDb,
                    }),
                  )
                : await updateAIConfig.handler(
                    createTestHandlerContext<UpdateContext>({
                      audit: NO_AUDIT,
                      scopedDb: NO_DB,
                      body: updateBody,
                      safeDb: db.safeDb,
                    }),
                  );
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
            if (reader === "update") {
              expect(db.operationCount()).toBe(1);
            }
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

  test("update fails closed instead of merging onto an empty config", async () => {
    const { safeDb, operationCount } = createSettingsDb();

    const result = await updateAIConfig.handler(
      createTestHandlerContext<UpdateContext>({
        audit: NO_AUDIT,
        scopedDb: NO_DB,
        body: updateBody,
        safeDb,
      }),
    );

    if (!("code" in result)) {
      throw new Error("Expected the decrypt failure to return a status");
    }
    expect(result.code).toBe(503);
    expect(result.response).toMatchObject({
      code: AI_CONFIG_UNREADABLE_ERROR_CODE,
    });
    // Only the settings read ran: the merge, the provider probe, and the
    // write never start, so the request cannot narrow the stored providers
    // down to the ones its body happens to carry.
    expect(operationCount()).toBe(1);
  });

  test("read reports the failure instead of an unconfigured org", async () => {
    const { safeDb } = createSettingsDb();

    const result = await readAIConfig.handler(
      createTestHandlerContext<ReadContext>({
        audit: NO_AUDIT,
        scopedDb: NO_DB,
        safeDb,
      }),
    );

    if (!("code" in result)) {
      throw new Error("Expected the decrypt failure to return a status");
    }
    expect(result.code).toBe(503);
    expect(result.response).toMatchObject({
      code: AI_CONFIG_UNREADABLE_ERROR_CODE,
    });
  });

  test.each([
    { aiConfigEncrypted: undecryptableRow.aiConfigEncrypted, aiConfigIv: null },
    { aiConfigEncrypted: null, aiConfigIv: undecryptableRow.aiConfigIv },
  ])(
    "incomplete envelopes are unavailable and are never overwritten",
    async (row) => {
      const marker = "marker-secret-in-incomplete-envelope";
      Object.assign(row, { ignored: marker });
      const updateDb = createSettingsDb(row);
      const updateResult = await updateAIConfig.handler(
        createTestHandlerContext<UpdateContext>({
          audit: NO_AUDIT,
          scopedDb: NO_DB,
          body: updateBody,
          safeDb: updateDb.safeDb,
        }),
      );
      expect(JSON.stringify(updateResult)).not.toContain(marker);
      expect(updateDb.operationCount()).toBe(1);

      const readDb = createSettingsDb(row);
      const readResult = await readAIConfig.handler(
        createTestHandlerContext<ReadContext>({
          audit: NO_AUDIT,
          scopedDb: NO_DB,
          safeDb: readDb.safeDb,
        }),
      );
      expect(JSON.stringify(readResult)).not.toContain(marker);
      expect(readResult).toMatchObject({
        code: 503,
        response: { code: AI_CONFIG_UNREADABLE_ERROR_CODE },
      });
    },
  );
});
