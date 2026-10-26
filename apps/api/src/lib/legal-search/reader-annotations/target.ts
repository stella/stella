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
 * The file a matter document's mark sits on: the file field of one version of
 * the document, from the document route's authorized context and the field
 * row it read, never from a request alone.
 */
export type MatterDocumentRef = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Where a new mark lands beyond what its request names: nothing more on a
 * public-law document; on matter content, the row its matter route read
 * under the caller's scope, and for a document the digest of each marked
 * page's text, by the page's block anchor.
 */
export type AnnotationPlacement =
  | { type: "public-law" }
  | ({ type: "verification-claim" } & VerificationClaimRef)
  | ({
      type: "matter-document";
      pageTextSha256ByAnchorId: ReadonlyMap<string, string>;
    } & MatterDocumentRef);

export const PUBLIC_LAW_ANNOTATION_PLACEMENT = {
  type: "public-law",
} as const satisfies AnnotationPlacement;

/**
 * Which marks an operation by annotation id may reach. The public-law routes
 * and the agent tools reach only document marks; a claim's comment is
 * changed through its matter's route, which carries the matter and the
 * verification feature gate, and a matter document's mark through the
 * document's route.
 */
export type AnnotationReach =
  | { type: "document" }
  | { type: "verification-claim"; workspaceId: SafeId<"workspace"> }
  | {
      type: "matter-document";
      entityId: SafeId<"entity">;
      workspaceId: SafeId<"workspace">;
    };

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

/** The stored columns that say what a mark sits on. */
export type AnnotationTargetRow = {
  entityId: SafeId<"entity"> | null;
  targetId: string;
  targetType: ReaderAnnotationTargetType;
  verificationClaimId: string | null;
  verificationRunId: string | null;
  workspaceId: SafeId<"workspace"> | null;
};

/**
 * Where a change to a mark is filed. A document mark is its own resource; a
 * claim's comment is filed under the verification it belongs to, beside the
 * reviewer actions on the same claim, with the comment and claim named in the
 * metadata and never the comment's words. A matter document's mark is its own
 * resource in its matter, naming the document and the file it sits on and
 * never the quoted words or the comment.
 */
export const annotationAuditSubject = ({
  annotationId,
  entityId,
  targetId,
  targetType,
  verificationClaimId,
  verificationRunId,
  workspaceId,
}: AnnotationTargetRow & { annotationId: string }): AnnotationAuditSubject => {
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
    case "matter-document": {
      if (entityId === null || workspaceId === null) {
        return panic("A matter document mark lacks its matter or document");
      }
      return {
        metadata: { entityId, fieldId: targetId },
        resourceId: annotationId,
        resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_ANNOTATION,
        workspaceId,
      };
    }
    default: {
      targetType satisfies never;
      return panic(`Unhandled annotation target: ${String(targetType)}`);
    }
  }
};
