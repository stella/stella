import { TaggedError } from "better-result";
import { expect, test } from "bun:test";

import { compareCodeUnit } from "@stll/collation";
import { failureGradeOf } from "@stll/errors";

import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { TAGGED_FAILURE_REASON } from "@/api/lib/observability/failure-tag-policy";
import { FAILURE_TAGS } from "@/api/lib/observability/failure-tags.gen";

const sink = failureSink({ event: "tag-policy.contract", expected: [] });

test("every declared failure tag runs through the real grader", () => {
  expect(Object.keys(TAGGED_FAILURE_REASON).toSorted(compareCodeUnit)).toEqual([
    ...FAILURE_TAGS,
  ]);
  for (const tag of FAILURE_TAGS) {
    class DeclaredFailure extends TaggedError(tag)<{ message: string }> {}
    const grading = gradeFailure(
      readEvidence(new DeclaredFailure({ message: "failure" })),
      sink,
    );
    const reason = TAGGED_FAILURE_REASON[tag];
    expect(grading).toMatchObject({ reason, grade: failureGradeOf(reason) });
  }
});

test("an undeclared tagged failure exposes a broken grading declaration", () => {
  class MissingPolicy extends TaggedError("MissingPolicy")<{
    message: string;
  }> {}
  expect(
    gradeFailure(readEvidence(new MissingPolicy({ message: "failure" })), sink),
  ).toMatchObject({
    reason: "invalid_declaration",
    grade: "defect",
    rule: "tag",
  });
});
