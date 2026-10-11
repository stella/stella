import { Result } from "better-result";
import { t } from "elysia";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { resolveAIConfigDefaults } from "../../ai-config-defaults";

const config = {
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  access: "read",
  mcp: { type: "internal", reason: "provider_secret" },
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

export default previewAIConfigDefaults;
