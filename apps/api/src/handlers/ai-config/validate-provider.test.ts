import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";

import validateProvider, { validateProviderBody } from "./validate-provider";

type Context = Parameters<typeof validateProvider.handler>[0];

describe("provider settings validation", () => {
  for (const provider of TANSTACK_AI_PROVIDERS) {
    for (const region of ["eu", "ch"] as const) {
      test(`rejects unsupported settings for ${provider} (${region}) before probing`, async () => {
        const result = await validateProvider.handler(
          createTestHandlerContext<Context>({
            audit: NO_AUDIT,
            safeDb: NO_DB,
            scopedDb: NO_DB,
            body: { provider, region, apiKey: "test-key" },
          }),
        );
        expect(result).toMatchObject({
          code: 400,
          response: {
            code: "ai_config_provider_invalid",
            message: `The selected endpoint setting is not supported by ${provider}. Use global.`,
          },
        });
      });
    }
  }
});

test("workspace probe schema requires a safe nonempty header value", () => {
  const body = { provider: "anthropic", apiKey: "fixture-key" };
  expect(
    Value.Check(validateProviderBody, {
      ...body,
      anthropicWorkspaceId: "wrk_safe-ID_01",
    }),
  ).toBe(true);
  for (const anthropicWorkspaceId of [
    "",
    "wrk.fixture",
    "wrk_fixture\n",
    "wrk\tfixture",
    "wrk with space",
    "wrk/path",
  ]) {
    expect(
      Value.Check(validateProviderBody, { ...body, anthropicWorkspaceId }),
    ).toBe(false);
  }
});

test("non-Anthropic workspace id is rejected before the provider probe", async () => {
  const result = await validateProvider.handler(
    createTestHandlerContext<Context>({
      audit: NO_AUDIT,
      safeDb: NO_DB,
      scopedDb: NO_DB,
      body: {
        provider: "google",
        apiKey: "fixture-key",
        anthropicWorkspaceId: "wrk_fixture",
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
});
