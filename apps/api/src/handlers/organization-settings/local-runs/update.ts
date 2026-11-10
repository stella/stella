import { panic, Result } from "better-result";
import * as v from "valibot";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";
import { DESKTOP_RUNNER_APPROVAL_MODES } from "@stll/api-contract/desktop-runner";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { updateLocalRunApprovalCeiling } from "@/api/lib/chat/local-run-approval-ceiling";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  description:
    "Set the most a chat turn run on a member's computer may do without " +
    "asking: ask, auto or full_auto. A turn above it is refused when it " +
    "starts; a run already going keeps its mode. A save that raced another " +
    "administrator's is refused with version_conflict. Changes are audited.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  // An agent that could change this could raise its own ceiling.
  mcp: { type: "internal", reason: "agent_autonomy_ceiling" },
  body: v.strictObject({
    maxApprovals: v.picklist(DESKTOP_RUNNER_APPROVAL_MODES),
  }),
} satisfies HandlerConfig;

const updateLocalRunApprovalCeilingRoute = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const outcome = yield* Result.await(
      safeDb(
        async (tx) =>
          await updateLocalRunApprovalCeiling(tx, {
            organizationId: session.activeOrganizationId,
            maxApprovals: body.maxApprovals,
            recordAuditEvent,
          }),
      ),
    );
    switch (outcome.type) {
      case "updated":
        return Result.ok({ maxApprovals: outcome.maxApprovals });
      case "changed":
        return Result.err(
          new HandlerError({
            status: 409,
            code: API_VERSION_CONFLICT_ERROR_CODE,
            message:
              "The local run permission limit changed; reload and try again",
          }),
        );
      default:
        outcome satisfies never;
        return panic("Unhandled local run ceiling outcome");
    }
  },
);

declareAggregateMutation(updateLocalRunApprovalCeilingRoute, {
  type: "independent",
  reason:
    "One column of the organization's settings row, written only while it still holds the value read; a concurrent save fails instead of overwriting it.",
});

export default updateLocalRunApprovalCeilingRoute;
