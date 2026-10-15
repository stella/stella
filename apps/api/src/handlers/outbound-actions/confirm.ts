import { Result } from "better-result";
import { and, eq, gt, sql } from "drizzle-orm";
import { t } from "elysia";

import { OUTBOUND_PREVIEW_HASH_PATTERN } from "@stll/api-contract/outbound-action";

import { abortableTx, abortTransaction } from "@/api/db/safe-db";
import { outboundActions } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  OUTBOUND_ACTION_EXECUTORS,
  type OutboundActionExecutors,
} from "@/api/lib/outbound-actions/executors";
import { readStoredOutboundPreview } from "@/api/lib/outbound-actions/store";

const config = {
  contract: "patch",
  permissions: { integration: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  // Only the signed-in user's own click may run an outbound action: no tool,
  // capability, CLI or connected app reaches this endpoint.
  mcp: { type: "internal", reason: "human_confirmation" },
  params: t.Object({ actionId: tSafeId("outboundAction") }),
  body: t.Object({
    /** Hash of the preview the user was shown and confirmed. */
    previewHash: t.String({
      maxLength: 64,
      pattern: OUTBOUND_PREVIEW_HASH_PATTERN,
    }),
  }),
} satisfies HandlerConfig;

const conflict = (message: string) =>
  abortTransaction(new HandlerError({ status: 409, message }));

/**
 * Execute a pending outbound action after the user confirmed its preview.
 * The confirm must echo the stored preview hash and the action must still be
 * pending and unexpired. It moves to `sending` through a conditional update
 * before the provider call, so a repeated or concurrent confirm can never
 * send twice, and an interrupted send is never retried.
 */
export const createConfirmOutboundActionHandler = (
  executors: OutboundActionExecutors,
) =>
  createSafeRootHandler(
    config,
    async function* ({
      body: { previewHash },
      params: { actionId },
      recordAuditEvent,
      safeDb,
      session,
      user,
    }) {
      const organizationId = session.activeOrganizationId;
      const now = new Date();

      const claimed = yield* Result.await(
        abortableTx(safeDb, async (tx) => {
          const action = (
            await tx
              .select({
                kind: outboundActions.kind,
                status: outboundActions.status,
                expiresAt: outboundActions.expiresAt,
                previewEncrypted: outboundActions.previewEncrypted,
                previewIv: outboundActions.previewIv,
                previewHash: outboundActions.previewHash,
              })
              .from(outboundActions)
              .where(
                and(
                  eq(outboundActions.id, actionId),
                  eq(outboundActions.organizationId, organizationId),
                  eq(outboundActions.userId, user.id),
                ),
              )
              .limit(1)
          ).at(0);
          if (!action) {
            return abortTransaction(
              new HandlerError({
                status: 404,
                message: "Prepared action not found",
              }),
            );
          }
          if (action.status !== "pending") {
            return conflict(`This action is already ${action.status}`);
          }
          if (action.expiresAt.getTime() <= now.getTime()) {
            return conflict("This preview expired; prepare it again");
          }
          if (action.previewHash !== previewHash) {
            return conflict(
              "The preview changed; review it again before confirming",
            );
          }
          const executor = executors[action.kind];
          if (executor === undefined) {
            return conflict("This action cannot be sent yet");
          }
          const preview = await readStoredOutboundPreview({
            organizationId,
            previewEncrypted: action.previewEncrypted,
            previewHash: action.previewHash,
            previewIv: action.previewIv,
          });
          if (Result.isError(preview)) {
            return abortTransaction(preview.error);
          }
          // The transition is the claim: it matches only while the action is
          // still pending, unexpired and bound to the confirmed preview.
          const transitioned = await tx
            .update(outboundActions)
            .set({ status: "sending", confirmedAt: now })
            .where(
              and(
                eq(outboundActions.id, actionId),
                eq(outboundActions.organizationId, organizationId),
                eq(outboundActions.userId, user.id),
                eq(outboundActions.status, "pending"),
                eq(outboundActions.previewHash, previewHash),
                // Expiry is judged by the database clock at the claim itself.
                gt(outboundActions.expiresAt, sql`now()`),
              ),
            )
            .returning({ id: outboundActions.id });
          if (transitioned.length === 0) {
            return conflict("This action was already confirmed");
          }
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.EXECUTE,
            resourceType: AUDIT_RESOURCE_TYPE.OUTBOUND_ACTION,
            resourceId: actionId,
            workspaceId: null,
            metadata: {
              kind: action.kind,
              operation: "confirm",
              previewHash,
            },
          });
          return { executor, kind: action.kind, preview: preview.value };
        }),
      );
      const { executor, kind, preview } = claimed;

      // The provider call runs outside any transaction and exactly once.
      const executed = await Result.tryPromise({
        try: async () =>
          await executor({
            actionId,
            organizationId,
            preview,
            safeDb,
            userId: user.id,
          }),
        catch: () => ({ failureCode: "provider_unreachable" }),
      });
      const outcome = Result.isError(executed) ? executed : executed.value;
      const completedAt = new Date();
      const settledValues = Result.isOk(outcome)
        ? {
            status: "sent" as const,
            providerMessageId: outcome.value.providerMessageId,
            failureCode: null,
            completedAt,
          }
        : {
            status: "failed" as const,
            providerMessageId: null,
            failureCode: outcome.error.failureCode,
            completedAt,
          };

      yield* Result.await(
        safeDb(async (tx) => {
          await tx
            .update(outboundActions)
            .set(settledValues)
            .where(
              and(
                eq(outboundActions.id, actionId),
                eq(outboundActions.status, "sending"),
              ),
            );
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.EXECUTE,
            resourceType: AUDIT_RESOURCE_TYPE.OUTBOUND_ACTION,
            resourceId: actionId,
            workspaceId: null,
            metadata: {
              kind,
              operation: settledValues.status,
              failureCode: settledValues.failureCode,
            },
          });
        }),
      );

      return Result.ok({
        status: settledValues.status,
        providerMessageId: settledValues.providerMessageId,
        failureCode: settledValues.failureCode,
      });
    },
  );

const confirmOutboundAction = createConfirmOutboundActionHandler(
  OUTBOUND_ACTION_EXECUTORS,
);

export default confirmOutboundAction;
