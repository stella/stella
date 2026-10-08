import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { TANSTACK_AI_PROVIDERS, BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { DataRegion, OrgAIConfig } from "@/api/lib/ai-config";
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import { toSafeId } from "@/api/lib/branded-types";
import * as outbound from "@/api/lib/safe-outbound-fetch";
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
  configured?: OrgAIConfig,
) => {
  const storedConfig: OrgAIConfig = configured ?? {
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

describe("Anthropic workspace settings", () => {
  const anthropicModels = BYOK_DEFAULT_MODELS.anthropic;
  const anthropicOverrides = {
    fast: { provider: "anthropic", modelId: anthropicModels.fast },
    chat: { provider: "anthropic", modelId: anthropicModels.chat },
    reasoning: { provider: "anthropic", modelId: anthropicModels.reasoning },
    pdf: { provider: "anthropic", modelId: anthropicModels.pdf },
  } as const;

  test("verifies and stores a user key and workspace together", async () => {
    const requests: {
      url: string;
      headers: Headers;
      method: string | undefined;
    }[] = [];
    const probe = spyOn(outbound, "safeOutboundFetchBytes").mockImplementation(
      async (options) => {
        requests.push({
          url: String(options.url),
          headers: new Headers(options.headers),
          method: options.method,
        });
        return Result.ok({
          body: new TextEncoder().encode('{"data":[]}').buffer,
          headers: new Headers(),
          ok: true,
          status: 200,
        });
      },
    );
    try {
      const db = createSettingsDb();
      const result = await updateAIConfig.handler(
        createTestHandlerContext<UpdateContext>({
          recordAuditEvent: auditRecorderDouble(),
          safeDb: db.safeDb,
          body: {
            providers: [
              {
                provider: "anthropic",
                apiKey: "sk-ant-usr-fixture",
                anthropicWorkspaceId: "wrk_fixture",
              },
            ],
            overrideModels: anthropicOverrides,
          },
        }),
      );
      expect(result).toMatchObject({
        providers: [
          { provider: "anthropic", anthropicWorkspaceId: "wrk_fixture" },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("sk-ant-usr-fixture");
      expect(requests).toHaveLength(1);
      expect(requests.at(0)?.url).toBe("https://api.anthropic.com/v1/models");
      expect(requests.at(0)?.method).toBe("GET");
      expect(requests.at(0)?.headers.get("anthropic-workspace-id")).toBe(
        "wrk_fixture",
      );
      const written = db.written();
      if (!written) {
        throw new Error("Expected saved settings");
      }
      const saved = await decryptAIConfig(
        toSafeId<"organization">("org_test"),
        written.aiConfigEncrypted,
        written.aiConfigIv,
      );
      expect(saved.providers).toEqual([
        {
          provider: "anthropic",
          apiKey: "sk-ant-usr-fixture",
          anthropicWorkspaceId: "wrk_fixture",
          region: "global",
        },
      ]);
    } finally {
      probe.mockRestore();
    }
  });

  test("missing workspace id returns actionable typed error and does not save", async () => {
    const message =
      "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.";
    const probe = spyOn(outbound, "safeOutboundFetchBytes").mockImplementation(
      async () =>
        Result.ok({
          body: new TextEncoder().encode(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message },
            }),
          ).buffer,
          headers: new Headers(),
          ok: false,
          status: 400,
        }),
    );
    try {
      const db = createSettingsDb();
      const result = await updateAIConfig.handler(
        createTestHandlerContext<UpdateContext>({
          recordAuditEvent: auditRecorderDouble(),
          safeDb: db.safeDb,
          body: {
            providers: [
              { provider: "anthropic", apiKey: "sk-ant-usr-fixture" },
            ],
            overrideModels: anthropicOverrides,
          },
        }),
      );
      expect(result).toMatchObject({
        code: 400,
        response: {
          code: "ai_config_anthropic_workspace_required",
          message: `anthropic: Anthropic rejected the key (HTTP 400): ${message}`,
        },
      });
      expect(db.written()).toBeUndefined();
    } finally {
      probe.mockRestore();
    }
  });

  for (const change of ["replace-key", "clear-id", "same-id"] as const) {
    test(`stored workspace id transition: ${change}`, async () => {
      const probe = spyOn(
        outbound,
        "safeOutboundFetchBytes",
      ).mockImplementation(async () =>
        Result.ok({
          body: new TextEncoder().encode('{"data":[]}').buffer,
          headers: new Headers(),
          ok: true,
          status: 200,
        }),
      );
      try {
        const db = createSettingsDb("global", {
          providers: [
            {
              provider: "anthropic",
              apiKey: "sk-ant-usr-existing",
              region: "global",
              anthropicWorkspaceId: "wrk_existing",
            },
          ],
          overrideModels: anthropicOverrides,
          decision: null,
        });
        const input =
          change === "replace-key"
            ? ({
                provider: "anthropic",
                apiKey: "sk-ant-api03-replacement",
              } as const)
            : ({
                provider: "anthropic",
                anthropicWorkspaceId:
                  change === "clear-id" ? "" : "wrk_existing",
              } as const);
        await updateAIConfig.handler(
          createTestHandlerContext<UpdateContext>({
            recordAuditEvent: auditRecorderDouble(),
            safeDb: db.safeDb,
            body: { providers: [input], overrideModels: anthropicOverrides },
          }),
        );
        const written = db.written();
        if (written === undefined) {
          throw new TypeError("Expected saved settings");
        }
        const saved = await decryptAIConfig(
          toSafeId<"organization">("org_test"),
          written.aiConfigEncrypted,
          written.aiConfigIv,
        );
        expect(saved.providers.at(0)).toMatchObject({
          apiKey:
            change === "replace-key"
              ? "sk-ant-api03-replacement"
              : "sk-ant-usr-existing",
        });
        const provider = saved.providers.at(0);
        if (provider?.provider !== "anthropic") {
          throw new TypeError("Expected Anthropic configuration");
        }
        expect(provider.anthropicWorkspaceId).toBe(
          change === "same-id" ? "wrk_existing" : undefined,
        );
        expect(probe).toHaveBeenCalledTimes(change === "same-id" ? 0 : 1);
      } finally {
        probe.mockRestore();
      }
    });
  }

  test("non-Anthropic workspace id is rejected before probing or writing", async () => {
    const db = createSettingsDb();
    const result = await updateAIConfig.handler(
      createTestHandlerContext<UpdateContext>({
        recordAuditEvent: auditRecorderDouble(),
        safeDb: db.safeDb,
        body: {
          providers: [
            { provider: "google", anthropicWorkspaceId: "wrk_fixture" },
          ],
          overrideModels,
        },
      }),
    );
    expect(result).toMatchObject({
      code: 400,
      response: {
        code: "ai_config_provider_invalid",
        message: "Workspace ID is supported only for Anthropic",
      },
    });
    expect(db.written()).toBeUndefined();
  });

  test("mixed provider failures retain all reasons with a generic code", async () => {
    const probe = spyOn(outbound, "safeOutboundFetchBytes").mockImplementation(
      async (options) => {
        const anthropic = String(options.url).includes("anthropic.com");
        const error = anthropic
          ? {
              code: "workspace_required",
              type: "invalid_request_error",
              message: "Workspace required",
            }
          : { code: 403, message: "Google access denied" };
        return Result.ok({
          body: new TextEncoder().encode(JSON.stringify({ error })).buffer,
          headers: new Headers(),
          ok: false,
          status: 400,
        });
      },
    );
    try {
      const db = createSettingsDb();
      const result = await updateAIConfig.handler(
        createTestHandlerContext<UpdateContext>({
          recordAuditEvent: auditRecorderDouble(),
          safeDb: db.safeDb,
          body: {
            providers: [
              { provider: "anthropic", apiKey: "sk-ant-usr-fixture" },
              { provider: "google", apiKey: "google-fixture" },
            ],
            overrideModels: anthropicOverrides,
          },
        }),
      );
      expect(JSON.stringify(result)).toContain("Google access denied");
      expect(result).toMatchObject({
        code: 400,
        response: {
          code: "ai_config_provider_validation_failed",
          message: expect.stringContaining("Workspace required"),
        },
      });
      expect(db.written()).toBeUndefined();
    } finally {
      probe.mockRestore();
    }
  });

  test("workspace update schema rejects unsafe header text and allows explicit clearing", () => {
    for (const anthropicWorkspaceId of ["wrk_safe-ID_01", ""]) {
      expect(
        Value.Check(updateAIConfig.config.body, {
          providers: [{ provider: "anthropic", anthropicWorkspaceId }],
          overrideModels: anthropicOverrides,
        }),
      ).toBe(true);
    }
    for (const anthropicWorkspaceId of [
      "wrk\r\nInjected",
      "wrk with space",
      "wrk/path",
    ]) {
      expect(
        Value.Check(updateAIConfig.config.body, {
          providers: [{ provider: "anthropic", anthropicWorkspaceId }],
          overrideModels: anthropicOverrides,
        }),
      ).toBe(false);
    }
  });
});
