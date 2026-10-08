import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { TANSTACK_AI_PROVIDERS, BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type {
  DataRegion,
  OrgAIConfig,
  OrgDecisionModelConfig,
} from "@/api/lib/ai-config";
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import { toSafeId } from "@/api/lib/branded-types";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
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

const createSettingsDb = (
  region: DataRegion | undefined = "global",
  decision: OrgDecisionModelConfig | null = null,
) => {
  const storedConfig: OrgAIConfig = {
    providers: TANSTACK_AI_PROVIDERS.map((provider) => ({
      provider,
      apiKey: "test-key",
      region,
    })),
    overrideModels,
    decision,
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
            recordAuditEvent: auditRecorderDouble(),
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
          recordAuditEvent: auditRecorderDouble(),
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

const openaiDecision = {
  provider: "openai",
  modelId: "gpt-6-luna",
  region: "eu",
} as const;

const createDecisionRequestSpy = () =>
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        Response.json({
          model: "gpt-6-luna",
          answers: [{ type: "predicate", name: "probe", probability: 0.99 }],
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

let fetch: ReturnType<typeof createDecisionRequestSpy>;
beforeAll(() => {
  fetch = createDecisionRequestSpy();
});
afterAll(() => {
  fetch.mockRestore();
});

describe("decision credential dependencies on settings save", () => {
  test.each(["omitted", "reuse"] as const)(
    "rejects removing a reused provider with decision %s before probing or writing",
    async (decisionMode) => {
      fetch.mockClear();
      const db = createSettingsDb("global", openaiDecision);
      const result = await updateAIConfig.handler(
        createTestHandlerContext<UpdateContext>({
          safeDb: db.safeDb,
          body: {
            providers: [{ provider: "google" }],
            overrideModels,
            ...(decisionMode === "reuse"
              ? { decision: { ...openaiDecision, apiKey: null } }
              : {}),
          },
        }),
      );
      expect(result).toMatchObject({
        code: 400,
        response: {
          code: "ai_config_decision_invalid",
          message:
            "The decision model reuses your OpenAI API key. Keep that provider and key, add a separate decision API key, or switch the decision provider.",
        },
      });
      expect(db.written()).toBeUndefined();
      expect(db.operations()).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test.each(["existing", "new"] as const)(
    "allows removing the provider using a separate decision key (%s)",
    async (keyMode) => {
      fetch.mockClear();
      const db = createSettingsDb(
        "global",
        keyMode === "existing"
          ? { ...openaiDecision, apiKey: "separate-key" }
          : openaiDecision,
      );
      const result = await updateAIConfig.handler(
        createTestHandlerContext<UpdateContext>({
          safeDb: db.safeDb,
          body: {
            providers: [{ provider: "google" }],
            overrideModels,
            ...(keyMode === "new"
              ? { decision: { ...openaiDecision, apiKey: "separate-key" } }
              : {}),
          },
        }),
      );
      expect(result).toMatchObject({
        providers: [{ provider: "google", region: "global" }],
        decision: { ...openaiDecision, apiKeyMasked: "sep****************" },
      });
      const written = db.written();
      expect(written).toBeDefined();
      if (!written) {
        panic("Expected saved settings");
      }
      const saved = await decryptAIConfig(
        toSafeId<"organization">("org_test"),
        written.aiConfigEncrypted,
        written.aiConfigIv,
      );
      expect(saved.decision).toEqual({
        ...openaiDecision,
        apiKey: "separate-key",
      });
      expect(fetch).toHaveBeenCalledTimes(keyMode === "new" ? 1 : 0);
      if (keyMode === "new") {
        expect(fetch.mock.calls.at(0)?.at(0)).toBe(
          "https://eu.api.openai.com/v1/decisions",
        );
      }
    },
  );
});
