import { panic } from "better-result";

import type {
  ReaderAnnotationTargetType,
  ReaderDocumentTargetType,
} from "@stll/api-contract/legal-reader-annotations";

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
 * The claim a verification comment sits on, from the matter route's
 * authorized context and the claim row it read, never from a request alone.
 */
export type VerificationClaimRef = {
  claimId: SafeId<"legalListClaim">;
  runId: SafeId<"legalListVerificationRun">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Which marks an operation by annotation id may reach. The public-law routes
 * and the agent tools reach only document marks; a claim's comment is
 * changed through its matter's route, which carries the matter and the
 * verification feature gate.
 */
export type AnnotationReach =
  | { type: "document" }
  | { type: "verification-claim"; workspaceId: SafeId<"workspace"> };

export const DOCUMENT_ANNOTATION_REACH = {
  type: "document",
} as const satisfies AnnotationReach;

/**
 * The trail names the thing a reader acted on, which is a note on a decision
 * or a note on a statute; the storage they share is not what an auditor reads
 * the log by. Total over the corpora, so a third one cannot be filed under a
 * name that predates it.
 */
const AUDIT_RESOURCE_TYPE_BY_DOCUMENT = {
  decision: AUDIT_RESOURCE_TYPE.CASE_LAW_DECISION_ANNOTATION,
  statute: AUDIT_RESOURCE_TYPE.STATUTE_ANNOTATION,
} as const satisfies Record<ReaderDocumentTargetType, AuditResourceType>;

type AnnotationAuditSubject = {
  metadata: Record<string, string>;
  resourceId: string;
  resourceType: AuditResourceType;
  workspaceId?: SafeId<"workspace">;
};

/**
 * Where a change to a mark is filed. A document mark is its own resource; a
 * claim's comment is filed under the verification it belongs to, beside the
 * reviewer actions on the same claim, with the comment and claim named in the
 * metadata and never the comment's words.
 */
export const annotationAuditSubject = ({
  annotationId,
  targetType,
  verificationClaimId,
  verificationRunId,
  workspaceId,
}: {
  annotationId: string;
  targetType: ReaderAnnotationTargetType;
  verificationClaimId: string | null;
  verificationRunId: string | null;
  workspaceId: SafeId<"workspace"> | null;
}): AnnotationAuditSubject => {
  switch (targetType) {
    case "decision":
    case "statute": {
      return {
        metadata: {},
        resourceId: annotationId,
        resourceType: AUDIT_RESOURCE_TYPE_BY_DOCUMENT[targetType],
      };
    }
    case "verification-claim": {
      if (
        verificationClaimId === null ||
        verificationRunId === null ||
        workspaceId === null
      ) {
        return panic("A claim comment row lacks its matter, run or claim");
      }
      return {
        metadata: { annotationId, claimId: verificationClaimId },
        resourceId: verificationRunId,
        resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
        workspaceId,
      };
    }
    default: {
      targetType satisfies never;
      return panic(`Unhandled annotation target: ${String(targetType)}`);
    }
  }
};
