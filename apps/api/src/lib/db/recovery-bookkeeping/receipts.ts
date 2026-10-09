import { panic } from "better-result";
import type { SQL } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import type {
  flowUploadTriggerIntents,
  pendingScoutEmissions,
} from "@/api/db/schema";
import {
  timestampCasToken,
  type TimestampCasToken,
} from "@/api/lib/db/timestamp-cas";

type CreateUploadReceipt = {
  type: "create-upload";
  tx: Pick<ScopedTransaction, "insert">;
  table: typeof flowUploadTriggerIntents;
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
  tx: Pick<ScopedTransaction, "insert">;
  table: typeof pendingScoutEmissions;
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
  tx: Pick<ScopedTransaction, "delete">;
  table: typeof pendingScoutEmissions;
  where: SQL;
};
type SettleUploadReceipt = {
  type: "settle-upload";
  tx: Pick<ScopedTransaction, "delete">;
  table: typeof flowUploadTriggerIntents;
  where: SQL;
};
type SettleScoutReceipt = {
  type: "settle-scout";
  tx: Pick<ScopedTransaction, "delete">;
  table: typeof pendingScoutEmissions;
  where: SQL;
};
type RecordedScoutReceipt = Pick<
  typeof pendingScoutEmissions.$inferSelect,
  "sourceId"
> & { nextAttemptAt: TimestampCasToken };

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
  // audit: skip — derived recovery receipts record delivery intent or token-fenced settlement for their audited source effects.
  switch (op.type) {
    case "create-upload":
      await op.tx.insert(op.table).values(op.rows).onConflictDoNothing();
      return;
    case "create-hearing":
      return await op.tx
        .insert(op.table)
        .values(op.rows)
        .onConflictDoNothing()
        .returning({
          sourceId: op.table.sourceId,
          nextAttemptAt: timestampCasToken(op.table.nextAttemptAt),
        });
    case "create-review":
      return await op.tx
        .insert(op.table)
        .values(op.rows)
        .onConflictDoNothing()
        .returning({
          nextAttemptAt: timestampCasToken(op.table.nextAttemptAt),
        });
    case "dequeue-scout":
      await op.tx.delete(op.table).where(op.where);
      return;
    case "settle-upload":
      return await op.tx
        .delete(op.table)
        .where(op.where)
        .returning({ entityId: op.table.entityId });
    case "settle-scout":
      return await op.tx
        .delete(op.table)
        .where(op.where)
        .returning({ sourceId: op.table.sourceId });
    default:
      op satisfies never;
      return panic("Unknown recovery receipt operation");
  }
}
