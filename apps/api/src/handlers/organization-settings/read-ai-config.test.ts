import { expect, test } from "bun:test";

import { resolveDefaultOverrideModels } from "@stll/ai-catalog/model-defaults-ledger";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import readAIConfig from "./read-ai-config";

type ReadContext = Parameters<typeof readAIConfig.handler>[0];

const configured = {
  providers: [
    { provider: "anthropic", apiKey: "fixture-provider-key", region: "global" },
    { provider: "google", apiKey: "fixture-second-key", region: "global" },
  ],
  overrideModels: {
    fast: { provider: "anthropic", modelId: "claude-opus-5-5" },
  },
  decision: null,
} satisfies OrgAIConfig;

test.each([undefined, configured])(
  "AI configuration reads return server defaults separately from stored overrides (%p)",
  async (stored) => {
    const database = createScopedDbMock({
      query: {
        organizationSettings: {
          findFirst: async () =>
            stored === undefined
              ? undefined
              : {
                  aiConfigEncrypted: Buffer.from(JSON.stringify(stored)),
                  aiConfigIv: Buffer.alloc(12),
                },
        },
      },
    });
    const response = await readAIConfig.handler(
      createTestHandlerContext<ReadContext>({
        audit: NO_AUDIT,
        safeDb: database.safeDb,
        scopedDb: NO_DB,
      }),
    );
    expect(response).toMatchObject({
      configured: stored !== undefined,
      defaultModels: resolveDefaultOverrideModels(
        stored?.providers.map(({ provider }) => provider) ?? [],
      ),
      providerDefaultModels: (stored?.providers ?? []).map(({ provider }) => ({
        provider,
        defaultModels: resolveDefaultOverrideModels([provider]),
      })),
      ...(stored === undefined
        ? {}
        : { overrideModels: stored.overrideModels }),
    });
    expect(JSON.stringify(response)).not.toContain("fixture-provider-key");
    expect(JSON.stringify(response)).not.toContain("fixture-second-key");
  },
);
