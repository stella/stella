import { Result } from "better-result";
import { expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import {
  isPrintedCourtJurisdiction,
  PRINTED_COURT_JURISDICTIONS,
} from "@stll/api-contract/court-identity";
import {
  resolveUsCourt,
  US_COURTS,
  US_REJECTED_COURT_IDS,
} from "@stll/api-contract/us-courts";

import { COURT_DIRECTORY_JURISDICTIONS } from "@/api/lib/case-law/decision-court-id-sql";
import {
  resolveDecisionCourt,
  resolveDecisionCourtId,
} from "@/api/lib/case-law/decision-court-identity";

const SCOTUS_NAME = "Supreme Court of the United States";

const rejectionOf = (input: Parameters<typeof resolveDecisionCourtId>[0]) => {
  const resolved = resolveDecisionCourtId(input);
  return Result.isError(resolved) ? resolved.error.reason : null;
};

test("a directory jurisdiction stores the court id it names, a printed-name one the id its name reads as, and every other none", () => {
  expect(COURT_DIRECTORY_JURISDICTIONS).toEqual(["USA"]);
  expect(PRINTED_COURT_JURISDICTIONS).toEqual(["CZE", "SVK"]);
  expect(
    resolveDecisionCourtId({
      country: "USA",
      court: SCOTUS_NAME,
      courtId: "scotus",
    }),
  ).toEqual(Result.ok("scotus"));
  for (const country of CASE_LAW_JURISDICTIONS.filter(
    (jurisdiction) =>
      jurisdiction !== "USA" && !isPrintedCourtJurisdiction(jurisdiction),
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

test("a printed court name is stored under its directory court's id and official name, whatever the publisher printed", () => {
  const stored = (country: string, court: string) =>
    resolveDecisionCourt({ country, court, courtId: undefined });
  const pardubice = {
    court: "Krajský soud v Hradci Králové – pobočka v Pardubicích",
    courtId: "KSHKPA",
  };
  // Two publishers' spellings of one court: one court.
  expect(
    stored("CZE", "Krajský soud v Hradci Králové, pobočka Pardubice"),
  ).toEqual(Result.ok(pardubice));
  expect(stored("CZE", pardubice.court)).toEqual(Result.ok(pardubice));
  // One publisher's two spellings of one court: one court.
  const banovce = {
    court: "Okresný súd Bánovce nad Bebravou",
    courtId: "OSBN",
  };
  expect(stored("SVK", "Okresný súd Bánovce n/B")).toEqual(Result.ok(banovce));
  expect(stored("SVK", banovce.court)).toEqual(Result.ok(banovce));
  expect(stored("SVK", "Najvyšší súd")).toEqual(
    Result.ok({ court: "Najvyšší súd Slovenskej republiky", courtId: "NSSR" }),
  );
});

test("a printed court name the directory cannot place is refused, never a new court", () => {
  expect(
    rejectionOf({
      country: "CZE",
      court: "Neznámý soud 58",
      courtId: undefined,
    }),
  ).toBe("unknown-name");
  expect(
    rejectionOf({
      country: "SVK",
      court: "Okresný súd Atlantída",
      courtId: undefined,
    }),
  ).toBe("unknown-name");
  // The id is the boundary's to assign, not an adapter's.
  expect(
    rejectionOf({
      country: "CZE",
      court: "Nejvyšší soud",
      courtId: "NS",
    }),
  ).toBe("unexpected");
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
    if (entry.type !== "rejected") {
      throw new Error(`Expected rejected court: ${courtId}`);
    }
    expect(rejectionOf({ country: "USA", court: SCOTUS_NAME, courtId })).toBe(
      entry.reason,
    );
  }
  expect(US_REJECTED_COURT_IDS.length).toBeGreaterThan(0);
});
