import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  LEGAL_LIST_SOURCE_VERIFICATION_STATUSES,
  legalListItemSourceDecisions,
  legalListItemSources,
} from "@/api/db/schema";
import { legalListRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIST_VERIFICATION_ITEM_OPERATION } from "@/api/lib/lists/item-operations";
import { LIST_ITEM_SOURCE_REVIEW_DECISION } from "@/api/lib/lists/review-decision-maps";
import {
  previousSourceDecision,
  sourceDecisionRows,
  sourceHasDecisionHistory,
} from "@/api/lib/lists/source-decision-history";
import { includes } from "@/api/lib/type-guards";
import { PERSON_APPROVED_EFFECT } from "@/api/mcp/person-approved-effect";

const bodySchema = v.object({
  id: resourceIdSchema("legalListItemSource"),
  listId: resourceIdSchema("legalList"),
  itemEntityId: resourceIdSchema("entity"),
  status: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
});
const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Set the verification status of one source attached to a list item. Any " +
    "status other than unverified records who set it and when; setting it " +
    "back to unverified clears both.",
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: legalListRealtimeUpdates,
  personApprovedEffect: PERSON_APPROVED_EFFECT.recordsAttestation,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const verifyItemSource = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const verificationStatus = body.status;
    if (
      !includes(LEGAL_LIST_SOURCE_VERIFICATION_STATUSES, verificationStatus)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid verification status",
        }),
      );
    }
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const now = new Date();
        // The update holds the source's row lock to commit, so the decision
        // history read and written below follows the order in which the
        // source changed; `old` is the row as that lock found it.
        const [previous] = await tx
          .update(legalListItemSources)
          .set({
            verificationStatus,
            verifiedBy: verificationStatus === "unverified" ? null : user.id,
            verifiedAt: verificationStatus === "unverified" ? null : now,
            updatedAt: now,
          })
          .where(
            and(
              eq(legalListItemSources.id, body.id),
              eq(legalListItemSources.workspaceId, workspaceId),
              eq(legalListItemSources.listId, body.listId),
              eq(legalListItemSources.itemEntityId, body.itemEntityId),
            ),
          )
          .returning(previousSourceDecision);
        if (!previous) {
          return false;
        }
        // Every set restamps who and when above, a restatement included, so
        // every set also joins the history: its newest event and the row
        // agree on who decided.
        await tx
          .insert(legalListItemSourceDecisions)
          .values(
            sourceDecisionRows({
              workspaceId,
              sourceId: body.id,
              previous,
              decision: LIST_ITEM_SOURCE_REVIEW_DECISION[verificationStatus],
              actorId: user.id,
              hasHistory: await sourceHasDecisionHistory(tx, body.id),
            }),
          )
          .onConflictDoNothing({ target: legalListItemSourceDecisions.id });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          resourceId: body.itemEntityId,
          metadata: {
            operation:
              LIST_VERIFICATION_ITEM_OPERATION.sourceVerificationChanged,
            sourceId: body.id,
            status: verificationStatus,
          },
        });
        return true;
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "List item source not found",
        }),
      );
    }
    return Result.ok({ id: body.id });
  },
);

export default verifyItemSource;
