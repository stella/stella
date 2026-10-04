import { sql } from "drizzle-orm";

import type { AuditEvent, AuditExecutionContext } from "@/api/lib/audit-log";
import type { DispatchOutcome } from "@/api/lib/hosted-usage-provider/dispatch-outcome";

export type ProviderEventReplayPerformer =
  | { type: "service"; id: string; name: null }
  | { type: "local"; username: string };

/** System receipt audit uses shared triggers and field diffs with an
 * environment-derived performer. Local runs have no authenticated tenant actor.
 * An ignored receipt need not have a locally resolved organization. */
export type ProviderEventReplayAttempt = {
  /** Operator-supplied claim, not an authenticated identity. */
  requestedBy: string | null;
  at: string;
  previousResult: "ignored";
  previousReason?: string | null;
  newResult: "ok" | "ignored";
  outcome: DispatchOutcome["kind"];
  reason?: string;
  dispatchReason?: string | null;
  execution: Omit<AuditExecutionContext, "performer"> & {
    performer: ProviderEventReplayPerformer;
  };
  event: AuditEvent;
};

/** Ordered attempts; only non-ignored outcomes make a receipt terminal. */
export type ProviderEventReplayAudit = ProviderEventReplayAttempt[];

// Shared by the purge query and its partial index so eligibility cannot drift.
export const PROVIDER_EVENT_REPLAY_AUDIT_TEXT_PATH = sql`'$[*] ? (exists(@.previousReason) || exists(@.reason) || exists(@.dispatchReason) || exists(@.event.metadata.reason) || exists(@.event.metadata.dispatchReason))'::jsonpath`;
