import { Panic, TaggedError, UnhandledException } from "better-result";
import { expect, test } from "bun:test";

import { compareCodeUnit } from "@stll/collation";
import { failureGradeOf } from "@stll/errors";

import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { TAGGED_FAILURE_REASON } from "@/api/lib/observability/failure-tag-policy";
import { FAILURE_TAGS } from "@/api/lib/observability/failure-tags.gen";

const sink = failureSink({ event: "tag-policy.contract", expected: [] });

test.each([
  { name: "Panic", error: () => new Panic({ message: "failure" }) },
  {
    name: "UnhandledException",
    error: () => new UnhandledException({ cause: undefined }),
  },
])(
  "a terminal $name retains the library wrapper's grading",
  ({ name, error }) => {
    const evidence = readEvidence(error());
    expect(evidence.nodes).toHaveLength(1);
    expect(evidence.nodes[0]).toMatchObject({ kind: "tagged", tag: name });
    expect(gradeFailure(evidence, sink)).toMatchObject({
      reason: "tagged_failure",
      grade: "defect",
      rule: "tag",
      evidenceDepth: 0,
    });
  },
);

test.each(["Panic", "UnhandledException"])(
  "a project tag named %s does not inherit library wrapper treatment",
  (tag) => {
    class ProjectFailure extends TaggedError(tag)<{ message: string }> {}
    expect(
      gradeFailure(
        readEvidence(new ProjectFailure({ message: "failure" })),
        sink,
      ),
    ).toMatchObject({
      reason: "invalid_declaration",
      grade: "defect",
      rule: "tag",
    });
  },
);

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
