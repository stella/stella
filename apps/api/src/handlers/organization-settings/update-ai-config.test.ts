import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import {
  TANSTACK_AI_PROVIDERS,
  BYOK_DEFAULT_MODELS,
  MODEL_ROLES,
} from "@stll/ai-catalog";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { resolveOrgAIModelForRole } from "@/api/lib/ai-config";
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
  fast: { provider: "google", modelId: models.fast.modelId },
  chat: { provider: "google", modelId: models.chat.modelId },
  reasoning: { provider: "google", modelId: models.reasoning.modelId },
  pdf: { provider: "google", modelId: models.pdf.modelId },
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
    fast: { provider: "anthropic", modelId: anthropicModels.fast.modelId },
    chat: { provider: "anthropic", modelId: anthropicModels.chat.modelId },
    reasoning: {
      provider: "anthropic",
      modelId: anthropicModels.reasoning.modelId,
    },
    pdf: { provider: "anthropic", modelId: anthropicModels.pdf.modelId },
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
      "wrk_fixture\n",
      "wrk_fixture\r\n",
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

describe("sparse custom model settings", () => {
  const readSaved = async (db: ReturnType<typeof createSettingsDb>) => {
    const written = db.written();
    if (written === undefined) {
      throw new Error("Expected persisted configuration");
    }
    return await decryptAIConfig(
      toSafeId<"organization">("org_test"),
      written.aiConfigEncrypted,
      written.aiConfigIv,
    );
  };
  test("replacing the first provider key preserves provider order and every default role", async () => {
    const existing = {
      providers: [
        { provider: "google", apiKey: "fixture-google-existing" },
        { provider: "anthropic", apiKey: "fixture-anthropic-existing" },
      ],
      overrideModels: null,
      decision: null,
    } satisfies OrgAIConfig;
    const db = createSettingsDb("global", existing);
    const probe = spyOn(outbound, "safeOutboundFetchBytes").mockImplementation(
      async () =>
        Result.ok({
          body: new TextEncoder().encode('{"data":[]}').buffer,
          headers: new Headers(),
          ok: true,
          status: 200,
        }),
    );
    try {
      const result = await updateAIConfig.handler(
        createTestHandlerContext<UpdateContext>({
          recordAuditEvent: auditRecorderDouble(),
          safeDb: db.safeDb,
          body: {
            providers: [
              { provider: "google", apiKey: "fixture-google-replacement" },
              { provider: "anthropic" },
            ],
          },
        }),
      );
      expect(result).toMatchObject({
        providers: [{ provider: "google" }, { provider: "anthropic" }],
        overrideModels: null,
      });
      const saved = await readSaved(db);
      expect(saved.providers.map(({ provider }) => provider)).toEqual([
        "google",
        "anthropic",
      ]);
      expect(saved.providers.at(0)?.apiKey).toBe("fixture-google-replacement");
      expect(saved.providers.at(1)?.apiKey).toBe("fixture-anthropic-existing");
      expect(saved.overrideModels).toBeNull();
      for (const role of MODEL_ROLES) {
        const selection = {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google[role].modelId,
        };
        expect(resolveOrgAIModelForRole(existing, role)).toEqual(selection);
        expect(resolveOrgAIModelForRole(saved, role)).toEqual(selection);
      }
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      probe.mockRestore();
    }
  });
  test("key-only settings preserve defaults without creating overrides", async () => {
    const db = createSettingsDb("global", {
      providers: [{ provider: "google", apiKey: "test-key" }],
      overrideModels: null,
      decision: null,
    });
    await updateAIConfig.handler(
      createTestHandlerContext<UpdateContext>({
        recordAuditEvent: auditRecorderDouble(),
        safeDb: db.safeDb,
        body: { providers: [{ provider: "google" }] },
      }),
    );
    expect((await readSaved(db)).overrideModels).toBeNull();
  });
  test("saving one custom role stores only that role, and null resets all roles", async () => {
    const db = createSettingsDb();
    const custom = { chat: overrideModels.chat };
    await updateAIConfig.handler(
      createTestHandlerContext<UpdateContext>({
        recordAuditEvent: auditRecorderDouble(),
        safeDb: db.safeDb,
        body: { providers: [{ provider: "google" }], overrideModels: custom },
      }),
    );
    const saved = await readSaved(db);
    expect(saved.overrideModels).toEqual(custom);
    const reset = createSettingsDb("global", saved);
    await updateAIConfig.handler(
      createTestHandlerContext<UpdateContext>({
        recordAuditEvent: auditRecorderDouble(),
        safeDb: reset.safeDb,
        body: { providers: [{ provider: "google" }], overrideModels: null },
      }),
    );
    expect((await readSaved(reset)).overrideModels).toBeNull();
  });
  test("credential-only saves retain custom roles and prune removed providers", async () => {
    const db = createSettingsDb("global", {
      providers: [
        { provider: "google", apiKey: "test-key" },
        { provider: "anthropic", apiKey: "test-key" },
      ],
      overrideModels: {
        chat: overrideModels.chat,
        fast: {
          provider: "anthropic",
          modelId: BYOK_DEFAULT_MODELS.anthropic.fast.modelId,
        },
      },
      decision: null,
    });
    await updateAIConfig.handler(
      createTestHandlerContext<UpdateContext>({
        recordAuditEvent: auditRecorderDouble(),
        safeDb: db.safeDb,
        body: { providers: [{ provider: "google" }] },
      }),
    );
    expect((await readSaved(db)).overrideModels).toEqual({
      chat: overrideModels.chat,
    });
  });
});
