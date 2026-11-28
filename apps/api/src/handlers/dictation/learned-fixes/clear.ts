import { Result } from "better-result";

import {
  dictationLearnedFixesClearQuerySchema,
  dictationLearnedFixesSchema,
} from "@stll/api-contract/dictation-learned-fixes";

import {
  ACCOUNT_ACCESS,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { clearLearnedFixes } from "@/api/lib/dictation/learned-fixes";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  permissions: { dictationLearnedFix: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: noResourceSetUpdates(
    "Each device drops its own copy when it next syncs",
  ),
  mcp: { type: "internal", reason: "native_tool_ui" },
  query: dictationLearnedFixesClearQuerySchema,
  response: safeHandlerResponseSchemas(dictationLearnedFixesSchema),
  aggregateMutation: {
    type: "independent",
    reason:
      "One row per member, replaced only at the revision it read; a write that lost a race reads again.",
  },
} as const satisfies HandlerConfig;

/**
 * Deletes everything dictation learned for the caller in the active
 * organization, on every device, if the generation named is still current.
 */
const clearLearnedFixesHandler = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user }) {
    const fixes = yield* Result.await(
      safeDb(
        async (tx) =>
          await clearLearnedFixes(
            tx,
            { organizationId: session.activeOrganizationId, userId: user.id },
            query,
          ),
      ),
    );
    return Result.ok(fixes);
  },
);

export default clearLearnedFixesHandler;
