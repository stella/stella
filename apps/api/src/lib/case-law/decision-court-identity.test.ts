import { Result } from "better-result";
import { expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import {
  resolveUsCourt,
  US_COURTS,
  US_REJECTED_COURT_IDS,
} from "@stll/api-contract/us-courts";

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

test("a directory court id is exact, accepted, and agrees with the stored name", () => {
  expect(
    rejectionOf({ country: "USA", court: SCOTUS_NAME, courtId: undefined }),
  ).toBe("missing");
  expect(
    rejectionOf({ country: "USA", court: SCOTUS_NAME, courtId: "SCOTUS" }),
  ).toBe("unknown");
  expect(
    rejectionOf({ country: "USA", court: "Supreme Court", courtId: "scotus" }),
  ).toBe("name-mismatch");
  // Every accepted court is written under its own canonical name, and under
  // no other court's, not even one sharing its source name.
  const refused = US_COURTS.filter(
    ({ canonicalName, id }) =>
      rejectionOf({ country: "USA", court: canonicalName, courtId: id }) !==
      null,
  );
  expect(refused).toEqual([]);
  expect(
    rejectionOf({
      country: "USA",
      court: "Massachusetts Land Court",
      courtId: "massland",
    }),
  ).toBe("name-mismatch");
  // A court the directory rejects stays outside the jurisdiction.
  for (const courtId of US_REJECTED_COURT_IDS) {
    const entry = resolveUsCourt(courtId);
    expect(rejectionOf({ country: "USA", court: SCOTUS_NAME, courtId })).toBe(
      entry.type === "rejected" ? entry.reason : "accepted",
    );
  }
  expect(US_REJECTED_COURT_IDS.length).toBeGreaterThan(0);
});
