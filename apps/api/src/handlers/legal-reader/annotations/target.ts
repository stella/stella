import type { ReaderAnnotationTargetType } from "@stll/api-contract/legal-reader-annotations";

import type { SafeDb } from "@/api/db/safe-db";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder, AuditResourceType } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Who a mark belongs to, from the session and never from the request: the
 * HTTP routes and the agent tools pass the same scope to the same handlers.
 */
export type AnnotationAuthorScope = {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/**
 * The trail names the thing a reader acted on, which is a note on a decision
 * or a note on a statute; the storage they share is not what an auditor reads
 * the log by. Total over the corpora, so a third one cannot be filed under a
 * name that predates it.
 */
const AUDIT_RESOURCE_TYPE_BY_TARGET = {
  decision: AUDIT_RESOURCE_TYPE.CASE_LAW_DECISION_ANNOTATION,
  statute: AUDIT_RESOURCE_TYPE.STATUTE_ANNOTATION,
} as const satisfies Record<ReaderAnnotationTargetType, AuditResourceType>;

export const annotationAuditResourceType = (
  targetType: ReaderAnnotationTargetType,
): AuditResourceType => AUDIT_RESOURCE_TYPE_BY_TARGET[targetType];
