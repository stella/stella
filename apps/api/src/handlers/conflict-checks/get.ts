import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readConflictCheck } from "@/api/lib/conflict-check/operation";
import { resourceIdSchema } from "@/api/lib/custom-schema";

const config = {
  contract: "patch",
  description:
    "Read one conflict check as the caller may see it: its parties, the " +
    "matched contacts with match evidence, the matters the caller can open, " +
    "and for any other matter only a count, a severity and whom to ask.",
  permissions: { conflictCheck: ["run"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "conflict-check", type: "required" },
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "contact_directory",
    consumesServices: false,
  },
  params: v.object({ checkId: resourceIdSchema("conflictCheck") }),
} satisfies HandlerConfig;

const getConflictCheck = createSafeRootHandler(
  config,
  async function* ({ params: { checkId }, safeDb, session }) {
    const view = yield* Result.await(
      readConflictCheck({
        safeDb,
        organizationId: session.activeOrganizationId,
        checkId,
      }),
    );
    return Result.ok(view);
  },
);

export default getConflictCheck;
