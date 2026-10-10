import {
  AUDIT_ACTION,
  type AuditEvent,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import { recordContentDeliveryReceipt } from "@/api/lib/files/content-delivery";

/**
 * An audit recorder for handler tests that writes no row but keeps the
 * production recorder's delivery contract: recording an ACCESS or DOWNLOAD
 * event issues the content-delivery receipt, as the production insert does
 * after its write. A handler declared as audited delivery therefore succeeds
 * under this double exactly when it records its access event, and fails when
 * it does not. `onRecord` sees the events of each call.
 */
export const auditRecorderDouble =
  (
    onRecord: (events: readonly AuditEvent[]) => void = () => undefined,
  ): AuditRecorder =>
  async (_tx, event) => {
    const events = Array.isArray(event) ? event : [event];
    onRecord(events);
    if (
      events.some(
        ({ action }) =>
          action === AUDIT_ACTION.ACCESS || action === AUDIT_ACTION.DOWNLOAD,
      )
    ) {
      recordContentDeliveryReceipt();
    }
    await Promise.resolve();
  };
