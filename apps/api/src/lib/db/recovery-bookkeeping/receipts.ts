import { panic } from "better-result";
import type { SQL } from "drizzle-orm";

import { withOrgScope } from "@/api/db/org-scope";
import type { OrgScope } from "@/api/db/org-scope";
import type { ScopedTransaction } from "@/api/db/safe-db";
import {
  flowUploadTriggerIntents,
  pendingScoutEmissions,
} from "@/api/db/schema";
import {
  type TimestampCasToken,
  timestampCasToken,
} from "@/api/lib/db/timestamp-cas";

type CreateUploadReceipt = {
  type: "create-upload";
  tx: ScopedTransaction;
  scope: OrgScope;
  rows: Pick<
    typeof flowUploadTriggerIntents.$inferInsert,
    | "definitionId"
    | "entityId"
    | "workspaceId"
    | "organizationId"
    | "fileExtension"
  >[];
};
type CreateScoutReceipt = {
  type: "create-hearing";
  tx: ScopedTransaction;
  scope: OrgScope;
  rows: Pick<
    typeof pendingScoutEmissions.$inferInsert,
    "organizationId" | "workspaceId" | "sourceKind" | "sourceId"
  >[];
};
type CreateReviewReceipt = Omit<CreateScoutReceipt, "type"> & {
  type: "create-review";
};
type DequeueScoutReceipt = {
  type: "dequeue-scout";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
};
type SettleUploadReceipt = {
  type: "settle-upload";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
};
type SettleScoutReceipt = {
  type: "settle-scout";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
};
type RecordedScoutReceipt = Pick<
  typeof pendingScoutEmissions.$inferSelect,
  "sourceId"
> & {
  nextAttemptAt: TimestampCasToken;
};

export function mutateRecoveryReceipt(
  op: CreateUploadReceipt | DequeueScoutReceipt,
): Promise<void>;
export function mutateRecoveryReceipt(
  op: CreateScoutReceipt,
): Promise<RecordedScoutReceipt[]>;
export function mutateRecoveryReceipt(
  op: CreateReviewReceipt,
): Promise<Pick<RecordedScoutReceipt, "nextAttemptAt">[]>;
export function mutateRecoveryReceipt(
  op: SettleUploadReceipt,
): Promise<Pick<typeof flowUploadTriggerIntents.$inferSelect, "entityId">[]>;
export function mutateRecoveryReceipt(
  op: SettleScoutReceipt,
): Promise<Pick<typeof pendingScoutEmissions.$inferSelect, "sourceId">[]>;
export async function mutateRecoveryReceipt(
  op:
    | CreateUploadReceipt
    | CreateScoutReceipt
    | CreateReviewReceipt
    | SettleUploadReceipt
    | SettleScoutReceipt
    | DequeueScoutReceipt,
): Promise<
  | void
  | RecordedScoutReceipt[]
  | Pick<RecordedScoutReceipt, "nextAttemptAt">[]
  | Pick<typeof flowUploadTriggerIntents.$inferSelect, "entityId">[]
  | Pick<typeof pendingScoutEmissions.$inferSelect, "sourceId">[]
> {
  return await withOrgScope({
    tx: op.tx,
    scope: op.scope,
    actor: { type: "system" },
    fn: async (tx) => {
      // audit: skip — derived recovery receipts record delivery intent or token-fenced settlement for their audited source effects. Pure recovery bookkeeping; no user/customer data or auth/permission change.
      switch (op.type) {
        case "create-upload":
          await tx
            .insert(flowUploadTriggerIntents)
            .values(op.rows)
            .onConflictDoNothing();
          return;
        case "create-hearing":
          return await tx
            .insert(pendingScoutEmissions)
            .values(op.rows)
            .onConflictDoNothing()
            .returning({
              sourceId: pendingScoutEmissions.sourceId,
              nextAttemptAt: timestampCasToken(
                pendingScoutEmissions.nextAttemptAt,
              ),
            });
        case "create-review":
          return await tx
            .insert(pendingScoutEmissions)
            .values(op.rows)
            .onConflictDoNothing()
            .returning({
              nextAttemptAt: timestampCasToken(
                pendingScoutEmissions.nextAttemptAt,
              ),
            });
        case "dequeue-scout":
          await tx.delete(pendingScoutEmissions).where(op.where);
          return;
        case "settle-upload":
          return await tx
            .delete(flowUploadTriggerIntents)
            .where(op.where)
            .returning({ entityId: flowUploadTriggerIntents.entityId });
        case "settle-scout":
          return await tx
            .delete(pendingScoutEmissions)
            .where(op.where)
            .returning({ sourceId: pendingScoutEmissions.sourceId });
        default:
          op satisfies never;
          return panic("Unknown recovery receipt operation");
      }
    },
  });
}
