import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { buildGroundedReviewFix } from "@/api/lib/grounded-review-fix";

describe("grounded review fixes", () => {
  test("exist exactly when text, supporting evidence, and a target anchor are present", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("replaceBlock" as const, "insertAfterBlock" as const),
        fc.string(),
        fc.boolean(),
        fc.array(fc.string({ minLength: 1 }), { maxLength: 5 }),
        (kind, proposedText, supportingEvidenceVerified, blockIds) => {
          const fix = buildGroundedReviewFix({
            kind,
            proposedText,
            supportingEvidenceVerified,
            targetAnchors: blockIds.map((blockId) => ({ blockId })),
          });
          const firstBlockId = blockIds.at(0);
          const shouldExist =
            proposedText.trim().length > 0 &&
            supportingEvidenceVerified &&
            firstBlockId !== undefined;

          expect(fix !== null).toBe(shouldExist);
          if (fix === null || firstBlockId === undefined) {
            return;
          }
          expect(fix).toEqual({
            kind,
            blockId: firstBlockId,
            text: proposedText.trim(),
          });
        },
      ),
    );
  });
});
