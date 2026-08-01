import { describe, expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";

import {
  buildReferenceReviewAuditEvent,
  type ReferenceReviewAuditEvent,
} from "@/api/handlers/document-reviews/reference-review-audit";
import type { AUDIT_ACTION, AuditEvent } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";

const reviewDocument = (suffix: string) => ({
  entityId: toSafeId<"entity">(`entity-${suffix}`),
  entityVersionId: toSafeId<"entityVersion">(`version-${suffix}`),
  file: { fileFieldId: toSafeId<"field">(`field-${suffix}`) },
});

describe("reference review audit event", () => {
  test("makes the review action part of the event type", () => {
    expectTypeOf<ReferenceReviewAuditEvent>().toExtend<AuditEvent>();
    expectTypeOf<ReferenceReviewAuditEvent["action"]>().toEqualTypeOf<
      typeof AUDIT_ACTION.REVIEW
    >();
  });

  test("records review completion against the target entity", () => {
    const target = reviewDocument("target");
    const references = [reviewDocument("first"), reviewDocument("second")];

    const event = buildReferenceReviewAuditEvent({
      target,
      references,
      findingCount: 3,
    });

    expect(event).toEqual({
      action: "review",
      resourceType: "entity",
      resourceId: target.entityId,
      changes: {
        referenceReview: {
          old: null,
          new: {
            targetFileFieldId: target.file.fileFieldId,
            targetEntityVersionId: target.entityVersionId,
            referenceEntityIds: references.map(({ entityId }) => entityId),
            referenceFileFieldIds: references.map(
              ({ file }) => file.fileFieldId,
            ),
            referenceEntityVersionIds: references.map(
              ({ entityVersionId }) => entityVersionId,
            ),
            findingCount: 3,
          },
        },
      },
    });
  });
});
