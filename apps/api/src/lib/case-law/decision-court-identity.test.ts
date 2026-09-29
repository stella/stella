import { Result } from "better-result";
import { expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { US_COURTS, US_WRITABLE_COURT_IDS } from "@stll/api-contract/us-courts";

import { COURT_DIRECTORY_JURISDICTIONS } from "@/api/lib/case-law/decision-court-id-sql";
import { resolveDecisionCourtId } from "@/api/lib/case-law/decision-court-identity";

const SCOTUS_NAME = "Supreme Court of the United States";

const rejectionOf = (input: Parameters<typeof resolveDecisionCourtId>[0]) => {
  const resolved = resolveDecisionCourtId(input);
  return Result.isError(resolved) ? resolved.error.reason : null;
};

test("a directory jurisdiction stores the court id it names, and every other stores none", () => {
  expect(COURT_DIRECTORY_JURISDICTIONS).toEqual(["USA"]);
  expect(
    resolveDecisionCourtId({
      country: "USA",
      court: SCOTUS_NAME,
      courtId: "scotus",
    }),
  ).toEqual(Result.ok("scotus"));
  for (const country of CASE_LAW_JURISDICTIONS.filter(
    (jurisdiction) => jurisdiction !== "USA",
  )) {
    expect(
      resolveDecisionCourtId({
        country,
        court: "Any court",
        courtId: undefined,
      }),
    ).toEqual(Result.ok(null));
    expect(
      rejectionOf({ country, court: "Any court", courtId: "scotus" }),
    ).toBe("unexpected");
  }
  // A country nobody declares identifies courts by name, like the rest.
  expect(
    resolveDecisionCourtId({
      country: "ROU",
      court: "Any",
      courtId: undefined,
    }),
  ).toEqual(Result.ok(null));
});

test("a directory court id is exact, writable, and agrees with the stored name", () => {
  expect(
    rejectionOf({ country: "USA", court: SCOTUS_NAME, courtId: undefined }),
  ).toBe("missing");
  expect(
    rejectionOf({ country: "USA", court: SCOTUS_NAME, courtId: "SCOTUS" }),
  ).toBe("unknown");
  expect(
    rejectionOf({ country: "USA", court: "Supreme Court", courtId: "scotus" }),
  ).toBe("name-mismatch");
  // Accepted by the directory but not enrolled for writing.
  const notWritable = US_COURTS.find(
    ({ id }) => !US_WRITABLE_COURT_IDS.has(id),
  );
  if (notWritable === undefined) {
    throw new Error("every accepted court is writable");
  }
  expect(
    rejectionOf({
      country: "USA",
      court: notWritable.canonicalName,
      courtId: notWritable.id,
    }),
  ).toBe("not-writable");
});
