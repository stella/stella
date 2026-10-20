import type { TSchema } from "@sinclair/typebox";
import { Result } from "better-result";
import { t } from "elysia";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { MODEL_OVERRIDE_GROUP_TASK } from "@stll/ai-catalog";

import {
  ACCOUNT_ACCESS,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

import { resolveAIConfigDefaults } from "../../ai-config-defaults";

const modelSelectionSchema = t.Union([
  t.Null(),
  t.Object({
    provider: t.UnionEnum(TANSTACK_AI_PROVIDERS),
    modelId: t.String(),
  }),
]);
const defaultModelsSchema = t.Object({
  fast: modelSelectionSchema,
  chat: modelSelectionSchema,
  reasoning: modelSelectionSchema,
  pdf: modelSelectionSchema,
} satisfies Record<keyof typeof MODEL_OVERRIDE_GROUP_TASK, TSchema>);

const config = {
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  access: "read",
  contract: "patch",
  mcp: { type: "internal", reason: "provider_secret" },
  response: safeHandlerResponseSchemas(
    t.Object({
      defaultModels: defaultModelsSchema,
      providerDefaultModels: t.Array(
        t.Object({
          provider: t.UnionEnum(TANSTACK_AI_PROVIDERS),
          defaultModels: defaultModelsSchema,
        }),
      ),
    }),
  ),
  body: t.Object({
    providers: t.Array(t.UnionEnum(TANSTACK_AI_PROVIDERS), {
      maxItems: TANSTACK_AI_PROVIDERS.length,
      uniqueItems: true,
    }),
  }),
} satisfies HandlerConfig;

// Preview public defaults for an unsaved provider list; no credentials or
// organization records participate in this calculation.
const previewAIConfigDefaults = createSafeRootHandler(
  config,
  // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
  async function* ({ body }) {
    return Result.ok(resolveAIConfigDefaults(body.providers));
  },
);

declareAggregateMutation(previewAIConfigDefaults.handler, {
  type: "independent",
  reason:
    "Resolves default models for the submitted provider set and returns them; it reads no aggregate and changes no stored state.",
});

export default previewAIConfigDefaults;
