import { Result } from "better-result";

import {
  dictationLearnedFixChangesSchema,
  dictationLearnedFixesSchema,
} from "@stll/api-contract/dictation-learned-fixes";

import {
  ACCOUNT_ACCESS,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { changeLearnedFixes } from "@/api/lib/dictation/learned-fixes";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  permissions: { dictationLearnedFix: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: noResourceSetUpdates(
    "Each device syncs its own copy on launch and after its own changes",
  ),
  mcp: { type: "internal", reason: "native_tool_ui" },
  body: dictationLearnedFixChangesSchema,
  response: safeHandlerResponseSchemas(dictationLearnedFixesSchema),
  aggregateMutation: {
    type: "independent",
    reason:
      "One row per member, replaced only at the revision it read; a write that lost a race reads again.",
  },
} as const satisfies HandlerConfig;

/**
 * Applies the changes a device made to the caller's learned fixes since it
 * last synced, and answers with the fixes every device should now hold.
 */
const changeLearnedFixesHandler = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user }) {
    const fixes = yield* Result.await(
      safeDb(
        async (tx) =>
          await changeLearnedFixes(
            tx,
            { organizationId: session.activeOrganizationId, userId: user.id },
            body,
          ),
      ),
    );
    return Result.ok(fixes);
  },
);

export default changeLearnedFixesHandler;
