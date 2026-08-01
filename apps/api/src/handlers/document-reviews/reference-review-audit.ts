import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditEvent,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

type ReferenceReviewAuditDocument = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  file: { fileFieldId: SafeId<"field"> };
};

type BuildReferenceReviewAuditEventArgs = {
  target: ReferenceReviewAuditDocument;
  references: readonly ReferenceReviewAuditDocument[];
  findingCount: number;
};

export type ReferenceReviewAuditEvent = {
  action: typeof AUDIT_ACTION.REVIEW;
  resourceType: typeof AUDIT_RESOURCE_TYPE.ENTITY;
  resourceId: SafeId<"entity">;
  changes: {
    referenceReview: {
      old: null;
      new: {
        targetFileFieldId: SafeId<"field">;
        targetEntityVersionId: SafeId<"entityVersion">;
        referenceEntityIds: SafeId<"entity">[];
        referenceFileFieldIds: SafeId<"field">[];
        referenceEntityVersionIds: SafeId<"entityVersion">[];
        findingCount: number;
      };
    };
  };
};

export const buildReferenceReviewAuditEvent = ({
  target,
  references,
  findingCount,
}: BuildReferenceReviewAuditEventArgs): ReferenceReviewAuditEvent => {
  const event = {
    action: AUDIT_ACTION.REVIEW,
    resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
    resourceId: target.entityId,
    changes: {
      referenceReview: {
        old: null,
        new: {
          targetFileFieldId: target.file.fileFieldId,
          targetEntityVersionId: target.entityVersionId,
          referenceEntityIds: references.map((reference) => reference.entityId),
          referenceFileFieldIds: references.map(
            (reference) => reference.file.fileFieldId,
          ),
          referenceEntityVersionIds: references.map(
            (reference) => reference.entityVersionId,
          ),
          findingCount,
        },
      },
    },
  } satisfies AuditEvent;

  return event;
};
