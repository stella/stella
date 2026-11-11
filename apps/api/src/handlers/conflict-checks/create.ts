import { Result } from "better-result";
import * as v from "valibot";

import {
  conflictCheckPartiesSchema,
  conflictCheckTitleSchema,
} from "@stll/api-contract/conflict-checks";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { runConflictCheck } from "@/api/lib/conflict-check/operation";
import { authorizeOrganizationReplay } from "@/api/lib/idempotency/organization-replay-authorization";

const config = {
  contract: "patch",
  description:
    "Run an internal conflict-of-interest check: screen the parties of a " +
    "prospective matter (each with its side: client, adverse or related) " +
    "against every contact and matter of the organization, and record the " +
    "result. The outcome is potential_conflict, incomplete (part of the " +
    "records was not searched; never read it as clear), needs_review, " +
    "information_only or no_matches. A check is never clear by itself: a " +
    "person records the decision. For a matter the caller cannot open, a " +
    "match shows only a count, its severity and whom to ask.",
  idempotency: { type: "replay" },
  permissions: { conflictCheck: ["run"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "contact_directory",
    consumesServices: false,
  },
  body: v.strictObject({
    title: v.exactOptional(conflictCheckTitleSchema),
    parties: conflictCheckPartiesSchema,
  }),
} satisfies HandlerConfig;

/** Run a conflict check and record it. */
const createConflictCheck = createSafeRootHandler(
  config,
  async function* ({ body, recordAuditEvent, safeDb, session, user }) {
    const view = yield* Result.await(
      runConflictCheck({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        title: body.title ?? null,
        parties: body.parties,
        recordAuditEvent,
      }),
    );
    return Result.ok(view);
  },
  { authorize: authorizeOrganizationReplay },
);

export default createConflictCheck;
