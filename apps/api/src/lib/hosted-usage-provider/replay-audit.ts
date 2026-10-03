import type { UsageProviderWebhookResult } from "@/api/db/schema";
import type { DispatchOutcome } from "@/api/handlers/hosted-usage-webhook/dispatch";
import type { AuditEvent, AuditExecutionContext } from "@/api/lib/audit-log";

/** System receipt audit uses the shared execution and field-diff contracts.
 * An ignored receipt need not have a locally resolved organization. */
export type ProviderEventReplayAudit = {
  actor: string;
  at: string;
  previousResult: "ignored";
  newResult: UsageProviderWebhookResult;
  outcome: DispatchOutcome["kind"];
  reason: string;
  execution: AuditExecutionContext;
  event: AuditEvent;
};
