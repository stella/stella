import type { Transaction } from "@/api/db/root";
import {
  caseLawReplayAuditEvents,
  REPLAY_MAINTENANCE_AUDIT_SERVICE,
} from "@/api/db/schema";

type ReplayMaintenanceAuditEvent = Omit<
  typeof caseLawReplayAuditEvents.$inferInsert,
  "id" | "serviceId"
>;

/** Tenantless maintenance audit; callers supply only closed actions and structured facts. */
export const recordReplayMaintenanceAuditEvent = async (
  tx: Transaction,
  event: ReplayMaintenanceAuditEvent,
): Promise<void> => {
  await tx.insert(caseLawReplayAuditEvents).values({
    ...event,
    id: Bun.randomUUIDv7(),
    serviceId: REPLAY_MAINTENANCE_AUDIT_SERVICE,
  });
};
