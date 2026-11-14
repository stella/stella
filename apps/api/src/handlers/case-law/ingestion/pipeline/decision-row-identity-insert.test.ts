import { describe, expect, test } from "bun:test";

import { FALLBACK_DECISION_UNIQUE_INDEXES } from "@/api/db/online-unique-indexes";
import { isConcurrentIdentityInsert } from "@/api/handlers/case-law/ingestion/pipeline/decision-row";
import { PG_ERROR } from "@/api/lib/pg-error";

const uniqueViolation = (constraint: string): Error =>
  Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: PG_ERROR.UNIQUE_VIOLATION,
    constraint,
  });

describe("isConcurrentIdentityInsert", () => {
  test.each(FALLBACK_DECISION_UNIQUE_INDEXES.map(({ name }) => name))(
    "treats a lost race on %s as contention",
    (name) => {
      expect(isConcurrentIdentityInsert(uniqueViolation(name))).toBe(true);
    },
  );

  test("leaves an unrelated unique violation to the caller", () => {
    expect(
      isConcurrentIdentityInsert(
        uniqueViolation("case_law_decisions_slug_uidx"),
      ),
    ).toBe(false);
  });
});
