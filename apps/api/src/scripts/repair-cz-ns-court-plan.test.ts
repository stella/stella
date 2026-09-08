import { describe, expect, test } from "bun:test";

import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  CZ_NS_COURT_REPAIR_OUTCOMES,
  decideCzNsCourtRepair,
} from "@/api/scripts/repair-cz-ns-court-plan";

const id = brandPersistedCaseLawDecisionId(
  "00000000-0000-4000-8000-000000000001",
);

const decide = (ecli: string, court: string) =>
  decideCzNsCourtRepair({ id, ecli, court });

describe("decideCzNsCourtRepair", () => {
  test("re-attributes a row the publisher's name was written onto", () => {
    expect(
      decide("ECLI:CZ:KSOS:2011:75.CO.19.2011.1", "Nejvyšší soud"),
    ).toEqual({
      outcome: CZ_NS_COURT_REPAIR_OUTCOMES.REATTRIBUTED,
      id,
      from: "Nejvyšší soud",
      court: "Krajský soud v Ostravě",
    });
  });

  test("holds a row that already names the court its ECLI does", () => {
    expect(
      decide("ECLI:CZ:KSOS:2011:75.CO.19.2011.1", "Krajský soud v Ostravě")
        .outcome,
    ).toBe(CZ_NS_COURT_REPAIR_OUTCOMES.HELD);
  });

  test("is a fixed point: re-deciding a repaired row changes nothing", () => {
    const first = decide("ECLI:CZ:VSPH:2015:1.VSPH.9.2015.1", "Nejvyšší soud");
    if (first.outcome !== CZ_NS_COURT_REPAIR_OUTCOMES.REATTRIBUTED) {
      throw new Error("Expected the first pass to re-attribute");
    }
    expect(
      decide("ECLI:CZ:VSPH:2015:1.VSPH.9.2015.1", first.court).outcome,
    ).toBe(CZ_NS_COURT_REPAIR_OUTCOMES.HELD);
  });

  test("reports a code it cannot name instead of writing a guess", () => {
    expect(decide("ECLI:CZ:ZZZZ:2015:1.A.9.2015.1", "Nejvyšší soud")).toEqual({
      outcome: CZ_NS_COURT_REPAIR_OUTCOMES.UNKNOWN_CODE,
      id,
      code: "ZZZZ",
    });
  });
});
