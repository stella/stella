/**
 * Court identity conformance: every adapter of a printed-name jurisdiction
 * writes decisions the write boundary can place on one directory court.
 *
 * A Czech or Slovak publisher prints the deciding court as text, and two
 * publishers, or one over the years, print one court differently. The write
 * boundary (`resolveDecisionCourt`) reads that text onto the court directory
 * and refuses a name it cannot place, so a spelling can never become a second
 * court. This drives every registered adapter of those jurisdictions from the
 * registry, so a new one is held to it without anyone remembering to add it:
 * the decision its fixture builds has to land on a directory court, under that
 * court's id and official name.
 */

import { Result } from "better-result";
import { afterEach, expect, test } from "bun:test";

import {
  directoryCourtById,
  isPrintedCourtJurisdiction,
  PRINTED_COURT_JURISDICTIONS,
} from "@stll/api-contract/court-identity";

import { listSourceRegistrations } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { resolveDecisionCourt } from "@/api/lib/case-law/decision-court-identity";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();

afterEach(() => {
  testFetchState.restore();
});

const printedCourtSources = listSourceRegistrations().flatMap(({ source }) => {
  const { country } = source;
  return isPrintedCourtJurisdiction(country)
    ? [{ key: source.key, country }]
    : [];
});

test("every printed-name jurisdiction has registered sources to hold", () => {
  const countries = new Set(printedCourtSources.map(({ country }) => country));
  expect([...countries].toSorted()).toEqual([...PRINTED_COURT_JURISDICTIONS]);
});

for (const { key, country } of printedCourtSources) {
  test(`${key}: the court it prints is one directory court`, async () => {
    // Fixtures stub the global fetch, so they build one at a time.
    const decision = await CASE_LAW_CONFORMANCE_FIXTURES[key]().buildDecision();
    testFetchState.restore();
    expect(decision.country).toBe(country);
    // The adapter states the name; the boundary owns the id and the
    // official name.
    expect(decision.courtId).toBeUndefined();
    const resolved = resolveDecisionCourt(decision);
    if (Result.isError(resolved)) {
      throw new TypeError(
        `${key} printed a court the directory cannot place: ${JSON.stringify(decision.court)} (${resolved.error.reason})`,
      );
    }
    const { court, courtId } = resolved.value;
    expect(courtId).not.toBeNull();
    expect(directoryCourtById(country, courtId ?? "")?.name).toBe(court);
  });
}
