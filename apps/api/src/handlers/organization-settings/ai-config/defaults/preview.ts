import { Result } from "better-result";
import * as v from "valibot";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { uniqueItems } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

import { resolveAIConfigDefaults } from "../../ai-config-defaults";

const config = {
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  access: "read",
  contract: "patch",
  mcp: { type: "internal", reason: "provider_secret" },
  body: v.object({
    providers: v.pipe(
      v.array(v.picklist(TANSTACK_AI_PROVIDERS)),
      v.maxLength(TANSTACK_AI_PROVIDERS.length),
      uniqueItems(),
    ),
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

declareAggregateMutation(previewAIConfigDefaults, {
  type: "independent",
  reason:
    "Resolves default models for the submitted provider set and returns them; it reads no aggregate and changes no stored state.",
});

export default previewAIConfigDefaults;
