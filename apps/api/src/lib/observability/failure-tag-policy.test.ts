import { Panic, TaggedError, UnhandledException } from "better-result";
import { expect, test } from "bun:test";

import { InvalidNumericTokenError } from "@stll/agent-input/numeric-token";
import { compareCodeUnit } from "@stll/collation";
import type { FailureGrade, FailureReason } from "@stll/errors";
import { failureGradeOf } from "@stll/errors";

import {
  PL_KIO_DOCUMENT_REJECTION,
  PlKioHtmlBudgetError,
} from "@/api/handlers/case-law/ingestion/adapters/pl-kio-response-budget";
import {
  VatRateCurrencyError,
  VatRateMalformedError,
  VatRateNotPublishedError,
  VatRateUnavailableError,
} from "@/api/lib/billing/vat-exchange-rates";
import { WorkDeadlineError, WorkRefusal } from "@/api/lib/load/work-admission";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { TAGGED_FAILURE_REASON } from "@/api/lib/observability/failure-tag-policy";
import { FAILURE_TAGS } from "@/api/lib/observability/failure-tags.gen";

const sink = failureSink({ event: "tag-policy.contract", expected: [] });

test.each([
  {
    error: new VatRateCurrencyError({
      message: "unsupported currency",
      currency: "USD",
    }),
    reason: "request_validation",
    grade: "client",
  },
  {
    error: new VatRateNotPublishedError({
      message: "publication pending",
      availableFrom: "2026-10-26",
    }),
    reason: "conflict",
    grade: "client",
  },
  {
    error: new VatRateMalformedError({
      message: "malformed upstream response",
    }),
    reason: "upstream_unavailable",
    grade: "transient",
  },
  {
    error: new VatRateUnavailableError({ message: "upstream unavailable" }),
    reason: "upstream_unavailable",
    grade: "transient",
  },
])(
  "VAT $error._tag keeps the invoice boundary's $grade disposition",
  ({ error, reason, grade }) => {
    for (const observed of [error, new UnhandledException({ cause: error })]) {
      expect(gradeFailure(readEvidence(observed), sink)).toMatchObject({
        reason,
        grade,
      });
    }
  },
);

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

const WORK_REFUSAL_EXPECTATIONS = {
  busy: {
    create: () =>
      new WorkRefusal({ message: "capacity", reason: "busy", retryAfterMs: 1 }),
    reason: "work_capacity_unavailable",
    grade: "transient",
  },
  memory: {
    create: () =>
      new WorkRefusal({
        message: "capacity",
        reason: "memory",
        retryAfterMs: 1,
      }),
    reason: "work_capacity_unavailable",
    grade: "transient",
  },
  aborted: {
    create: () =>
      new WorkRefusal({
        message: "cancelled",
        reason: "aborted",
        retryAfterMs: 0,
      }),
    reason: "work_cancelled",
    grade: "anticipated",
  },
} as const satisfies Record<
  WorkRefusal["reason"],
  {
    create: () => WorkRefusal;
    reason: FailureReason;
    grade: FailureGrade;
  }
>;

test("bounded work refusals keep their declared outcomes through the admission wrapper", () => {
  for (const { create, reason, grade } of Object.values(
    WORK_REFUSAL_EXPECTATIONS,
  )) {
    const error = create();
    for (const observed of [error, new UnhandledException({ cause: error })]) {
      expect(gradeFailure(readEvidence(observed), sink)).toMatchObject({
        reason,
        grade,
      });
    }
  }
  const deadline = new WorkDeadlineError({ message: "bounded deadline" });
  expect(
    gradeFailure(
      readEvidence(new UnhandledException({ cause: deadline })),
      sink,
    ),
  ).toMatchObject({ reason: "work_deadline_exceeded", grade: "transient" });
});

test("numeric and publisher budget rejections retain their boundary outcomes", () => {
  expect(
    gradeFailure(
      readEvidence(
        new InvalidNumericTokenError({
          message: "invalid input",
          reason: "syntax",
        }),
      ),
      sink,
    ),
  ).toMatchObject({ reason: "request_invalid", grade: "client" });
  for (const reason of Object.values(PL_KIO_DOCUMENT_REJECTION)) {
    const error = new PlKioHtmlBudgetError({
      message: "bounded publisher response",
      reason,
    });
    expect(gradeFailure(readEvidence(error), sink)).toMatchObject({
      reason: "publisher_resource_limit",
      grade: "anticipated",
    });
  }
});
