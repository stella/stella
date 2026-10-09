import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { TANSTACK_AI_PROVIDERS, BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { DataRegion, OrgAIConfig } from "@/api/lib/ai-config";
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import { toSafeId } from "@/api/lib/branded-types";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import updateAIConfig from "./update-ai-config";

type UpdateContext = Parameters<typeof updateAIConfig.handler>[0];

const models = BYOK_DEFAULT_MODELS.google;
const overrideModels = {
  fast: { provider: "google", modelId: models.fast },
  chat: { provider: "google", modelId: models.chat },
  reasoning: { provider: "google", modelId: models.reasoning },
  pdf: { provider: "google", modelId: models.pdf },
} as const;

const createSettingsDb = (region: DataRegion | undefined = "global") => {
  const storedConfig: OrgAIConfig = {
    providers: TANSTACK_AI_PROVIDERS.map((provider) => ({
      provider,
      apiKey: "test-key",
      region,
    })),
    overrideModels,
    decision: null,
  };
  const row = {
    aiConfigEncrypted: Buffer.from(JSON.stringify(storedConfig)),
    aiConfigIv: Buffer.alloc(12),
  };
  let written: typeof row | undefined;
  let operations = 0;
  const tx = asTestRaw<Transaction>({
    insert: () => ({
      values: (value: typeof row) => ({
        onConflictDoUpdate: () => {
          written = value;
        },
      }),
    }),
  });
  const safeDb: SafeDb = async <T>(
    operation: (tx: Transaction) => Promise<T>,
  ) => {
    operations += 1;
    return operations === 1
      ? Result.ok(asTestRaw<T>(row))
      : Result.ok(await operation(tx));
  };
  return { safeDb, written: () => written, operations: () => operations };
};

describe("organization AI settings validation", () => {
  for (const provider of TANSTACK_AI_PROVIDERS) {
    for (const region of ["eu", "ch"] as const) {
      test(`rejects unsupported settings for ${provider} (${region}) before writing`, async () => {
        const db = createSettingsDb();
        const result = await updateAIConfig.handler(
          createTestHandlerContext<UpdateContext>({
            scopedDb: NO_DB,
            audit: auditRecorderDouble(),
            safeDb: db.safeDb,
            body: { providers: [{ provider, region }], overrideModels },
          }),
        );
        expect(result).toMatchObject({
          code: 400,
          response: {
            code: "ai_config_provider_invalid",
            message: `The selected endpoint setting is not supported by ${provider}. Use global.`,
          },
        });
        expect(db.written()).toBeUndefined();
        expect(db.operations()).toBe(1);
      });
    }
  }

  for (const region of ["global", undefined] as const) {
    test(`saves supported or absent settings (${String(region)})`, async () => {
      const db = createSettingsDb();
      const result = await updateAIConfig.handler(
        createTestHandlerContext<UpdateContext>({
          scopedDb: NO_DB,
          audit: auditRecorderDouble(),
          safeDb: db.safeDb,
          body: { providers: [{ provider: "google", region }], overrideModels },
        }),
      );
      expect(result).toMatchObject({
        providers: [{ provider: "google", region: "global" }],
      });
      const written = db.written();
      expect(written).toBeDefined();
      if (!written) {
        throw new Error("Expected saved settings");
      }
      const saved = await decryptAIConfig(
        toSafeId<"organization">("org_test"),
        written.aiConfigEncrypted,
        written.aiConfigIv,
      );
      expect(saved.providers).toEqual([
        { provider: "google", apiKey: "test-key", region: "global" },
      ]);
    });
  }
});
