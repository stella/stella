import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import { resolveDefaultOverrideModels } from "@stll/ai-catalog/model-defaults-ledger";

import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import previewAIConfigDefaults from "./preview";

type PreviewContext = Parameters<typeof previewAIConfigDefaults.handler>[0];

const PROVIDER_LISTS = [
  [],
  ...TANSTACK_AI_PROVIDERS.map((provider) => [provider]),
  ["mistral", "openai"],
  ["openai", "mistral"],
  [...TANSTACK_AI_PROVIDERS],
] as const;

describe("AI defaults preview", () => {
  test.each(PROVIDER_LISTS.map((providers) => [providers] as const))(
    "returns ledger defaults for %p without database access",
    async (providers) => {
      const response = await previewAIConfigDefaults.handler(
        createTestHandlerContext<PreviewContext>({
          audit: NO_AUDIT,
          safeDb: NO_DB,
          scopedDb: NO_DB,
          body: { providers: [...providers] },
        }),
      );
      expect(response).toEqual({
        defaultModels: resolveDefaultOverrideModels(providers),
        providerDefaultModels: providers.map((provider) => ({
          provider,
          defaultModels: resolveDefaultOverrideModels([provider]),
        })),
      });
    },
  );

  test("bounds the supported provider list and rejects duplicates", () => {
    const schema = previewAIConfigDefaults.config.body;
    for (const providers of PROVIDER_LISTS) {
      expect(v.is(schema, { providers })).toBe(true);
    }
    for (const providers of [
      ["unknown"],
      ["google", "google"],
      [...TANSTACK_AI_PROVIDERS, "google"],
    ]) {
      expect(v.is(schema, { providers })).toBe(false);
    }
  });

  test("declares authenticated settings access and a read-only internal contract", () => {
    expect(previewAIConfigDefaults.config).toMatchObject({
      permissions: { organizationSettings: ["update"] },
      access: "read",
      mcp: { type: "internal", reason: "provider_secret" },
    });
  });
});
