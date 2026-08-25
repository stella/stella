import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  normalizeParties,
  proposedTopicsSchema,
} from "@/api/handlers/document-reviews/reference-topics";
import {
  mergeProposedReviewTopics,
  validateReviewTopics,
} from "@/api/handlers/document-reviews/review-topics";
import type { DocumentReviewTopic } from "@/api/handlers/document-reviews/schemas";
import { REVIEW_PARTIES_MAX } from "@/api/lib/document-review/contract";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";

const seededTopic = {
  type: "playbook",
  topicId: "11111111-1111-4111-8111-111111111111",
  positionId: "22222222-2222-4222-8222-222222222222",
  title: "Liability",
  context: "Apply the approved position.",
  included: true,
} as const satisfies DocumentReviewTopic;

describe("proposedTopicsSchema", () => {
  // The schema is handed to the provider as JSON Schema; a valibot action
  // with no JSON Schema form (trim, transform) only fails at request time.
  test("converts to provider JSON Schema", () => {
    const schema = toTanStackValibotSchema(proposedTopicsSchema);
    const json = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    expect(json).toMatchObject({ type: "object" });
  });
});

describe("reference topic normalization", () => {
  test("trims parties and omits entries without a role", () => {
    expect(
      normalizeParties([
        { role: "  Purchaser  ", name: "  Example Holdings a.s.  " },
        { role: " Seller ", name: "   " },
        { role: "   ", name: "Ignored Entity" },
      ]),
    ).toEqual([
      { role: "Purchaser", name: "Example Holdings a.s." },
      { role: "Seller", name: null },
    ]);
  });

  test("caps normalized parties at the review limit", () => {
    const parties = Array.from(
      { length: REVIEW_PARTIES_MAX + 2 },
      (_, index) => ({ role: `Party ${index + 1}`, name: null }),
    );

    const normalized = normalizeParties(parties);

    expect(normalized).toHaveLength(REVIEW_PARTIES_MAX);
    expect(normalized.at(-1)?.role).toBe(`Party ${REVIEW_PARTIES_MAX}`);
  });

  test("preserves seeded topics and ignores duplicate proposed titles", () => {
    const merged = mergeProposedReviewTopics(
      [seededTopic],
      [
        { title: " liability ", context: "Duplicate" },
        { title: " Governing law ", context: " Compare the clauses. " },
        { title: "GOVERNING LAW", context: "Duplicate proposal" },
      ],
    );

    expect(merged).toEqual([
      seededTopic,
      {
        type: "reference",
        topicId: expect.any(String),
        title: "Governing law",
        context: "Compare the clauses.",
        included: true,
      },
    ]);
  });
});

describe("review topic validation", () => {
  test("rejects duplicate topic and playbook-position identifiers", () => {
    const duplicateTopicId = validateReviewTopics(
      [
        seededTopic,
        {
          type: "reference",
          topicId: seededTopic.topicId,
          title: "Governing law",
          context: "",
          included: true,
        },
      ],
      "proposal",
    );
    const duplicatePositionId = validateReviewTopics(
      [
        seededTopic,
        {
          ...seededTopic,
          topicId: "33333333-3333-4333-8333-333333333333",
          title: "Liability carve-outs",
        },
      ],
      "proposal",
    );

    expect(Result.isError(duplicateTopicId)).toBe(true);
    expect(Result.isError(duplicatePositionId)).toBe(true);
    if (Result.isOk(duplicateTopicId) || Result.isOk(duplicatePositionId)) {
      return;
    }
    expect(duplicateTopicId.error.message).toBe(
      "Review topic identifiers must be unique.",
    );
    expect(duplicatePositionId.error.message).toBe(
      "Playbook positions must be unique within a review.",
    );
  });

  test("allows excluded proposal seeds but rejects them for comparison", () => {
    const excluded = [{ ...seededTopic, included: false }];

    expect(Result.isOk(validateReviewTopics(excluded, "proposal"))).toBe(true);
    const comparison = validateReviewTopics(excluded, "comparison");
    expect(Result.isError(comparison)).toBe(true);
    if (Result.isOk(comparison)) {
      return;
    }
    expect(comparison.error.message).toBe(
      "Comparison topics must be confirmed.",
    );
  });
});
