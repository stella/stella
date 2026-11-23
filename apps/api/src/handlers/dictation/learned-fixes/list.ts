import { Result } from "better-result";

import { dictationLearnedFixesSchema } from "@stll/api-contract/dictation-learned-fixes";

import {
  ACCOUNT_ACCESS,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readLearnedFixes } from "@/api/lib/dictation/learned-fixes";

const config = {
  contract: "patch",
  permissions: { dictationLearnedFix: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  // The member's own dictation settings; agents do not dictate.
  mcp: { type: "internal", reason: "native_tool_ui" },
  response: safeHandlerResponseSchemas(dictationLearnedFixesSchema),
} as const satisfies HandlerConfig;

/** The fixes dictation learned from how the caller corrects it, in the active organization. */
const listLearnedFixes = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const fixes = yield* Result.await(
      safeDb(
        async (tx) =>
          await readLearnedFixes(tx, {
            organizationId: session.activeOrganizationId,
            userId: user.id,
          }),
      ),
    );
    return Result.ok(fixes);
  },
);

export default listLearnedFixes;
