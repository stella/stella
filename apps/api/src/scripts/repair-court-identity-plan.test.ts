import { describe, expect, test } from "bun:test";

import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  COURT_IDENTITY_REPAIR_OUTCOMES,
  type CourtIdentityRow,
  decideCourtIdentityRepair,
  parseCourtIdentityPage,
  parseCourtIdentityWrite,
} from "@/api/scripts/repair-court-identity-plan";

const id = brandPersistedCaseLawDecisionId(
  "00000000-0000-4000-8000-000000000001",
);

const row = (
  overrides: Partial<CourtIdentityRow> & Pick<CourtIdentityRow, "court">,
): CourtIdentityRow => ({
  id,
  country: "CZE",
  courtId: null,
  metadataHasCourt: true,
  ...overrides,
});

const PARDUBICE = "Krajský soud v Hradci Králové – pobočka v Pardubicích";

describe("decideCourtIdentityRepair", () => {
  test("renames a publisher's spelling of a directory court to its official name", () => {
    const printed = "Krajský soud v Hradci Králové, pobočka Pardubice";
    expect(printed).not.toBe(PARDUBICE);
    expect(decideCourtIdentityRepair(row({ court: printed }))).toEqual({
      outcome: COURT_IDENTITY_REPAIR_OUTCOMES.RENAME,
      row: row({ court: printed }),
      from: printed,
      to: PARDUBICE,
      courtId: "KSHKPA",
    });
  });

  test("renames an abbreviation a register prints for the same court", () => {
    const repair = decideCourtIdentityRepair(
      row({ country: "SVK", court: "Okresný súd Bánovce n/B" }),
    );
    expect(repair).toMatchObject({
      outcome: COURT_IDENTITY_REPAIR_OUTCOMES.RENAME,
      to: "Okresný súd Bánovce nad Bebravou",
      courtId: "OSBN",
    });
  });

  test("gives a row stored under the official name only the id", () => {
    expect(decideCourtIdentityRepair(row({ court: PARDUBICE }))).toMatchObject({
      outcome: COURT_IDENTITY_REPAIR_OUTCOMES.ASSIGN_ID,
      from: PARDUBICE,
      to: PARDUBICE,
      courtId: "KSHKPA",
    });
  });

  test("holds a row that already carries the id and the official name", () => {
    expect(
      decideCourtIdentityRepair(row({ court: PARDUBICE, courtId: "KSHKPA" }))
        .outcome,
    ).toBe(COURT_IDENTITY_REPAIR_OUTCOMES.HELD);
  });

  test("is a fixed point: re-deciding a repaired row changes nothing", () => {
    const first = decideCourtIdentityRepair(
      row({ country: "SVK", court: "Krajský súd Banská Bystrica" }),
    );
    if (first.outcome !== COURT_IDENTITY_REPAIR_OUTCOMES.RENAME) {
      throw new Error("Expected the first pass to rename");
    }
    expect(
      decideCourtIdentityRepair(
        row({ country: "SVK", court: first.to, courtId: first.courtId }),
      ).outcome,
    ).toBe(COURT_IDENTITY_REPAIR_OUTCOMES.HELD);
  });

  test("reports a name no directory court answers to instead of guessing", () => {
    for (const court of ["Neznámý soud 58", "(nezadán)"]) {
      expect(decideCourtIdentityRepair(row({ court }))).toEqual({
        outcome: COURT_IDENTITY_REPAIR_OUTCOMES.UNKNOWN,
        row: row({ court }),
        spelling: court,
      });
    }
  });

  test("never replaces a court id the row already carries", () => {
    expect(
      decideCourtIdentityRepair(row({ court: PARDUBICE, courtId: "KSHK" })),
    ).toEqual({
      outcome: COURT_IDENTITY_REPAIR_OUTCOMES.CONFLICTING_ID,
      row: row({ court: PARDUBICE, courtId: "KSHK" }),
      courtId: "KSHKPA",
    });
  });

  test("leaves a country not identified by a printed name alone", () => {
    expect(
      decideCourtIdentityRepair(row({ country: "POL", court: "Sąd Najwyższy" }))
        .outcome,
    ).toBe(COURT_IDENTITY_REPAIR_OUTCOMES.OUT_OF_SCOPE);
  });
});

describe("parseCourtIdentityPage", () => {
  test("an empty result ends the walk", () => {
    expect(parseCourtIdentityPage([])).toEqual({ rows: [], cursor: null });
  });

  test("reads every row and takes the cursor from the last", () => {
    const second = "00000000-0000-4000-8000-000000000002";
    const page = parseCourtIdentityPage([
      {
        id,
        cursor_created_at: "2020-01-01 00:00:00.000001+00",
        country: "CZE",
        court: PARDUBICE,
        court_id: null,
        metadata_has_court: false,
      },
      {
        id: second,
        cursor_created_at: "2020-01-01 00:00:00.000002+00",
        country: "SVK",
        court: "Najvyšší súd",
        court_id: "NSSR",
        metadata_has_court: true,
      },
    ]);
    expect(page.rows).toEqual([
      row({ court: PARDUBICE, metadataHasCourt: false }),
      row({
        id: brandPersistedCaseLawDecisionId(second),
        country: "SVK",
        court: "Najvyšší súd",
        courtId: "NSSR",
      }),
    ]);
    expect(page.cursor).toEqual({
      createdAt: "2020-01-01 00:00:00.000002+00",
      id: brandPersistedCaseLawDecisionId(second),
    });
  });

  test("refuses a row it cannot read rather than skipping it", () => {
    expect(() => parseCourtIdentityPage([{ id, court: PARDUBICE }])).toThrow(
      "metadata_has_court",
    );
  });
});

describe("parseCourtIdentityWrite", () => {
  test("reads back what the run logs", () => {
    const write = {
      id,
      adapter: "cz-regional",
      from: "Krajský soud v Hradci Králové, pobočka Pardubice",
      to: PARDUBICE,
      courtId: "KSHKPA",
      previousCourtId: null,
      addedMetadataCourt: false,
    };
    expect(parseCourtIdentityWrite(JSON.stringify(write))).toEqual(write);
  });

  test("refuses a line missing what a revert is guarded on", () => {
    expect(() =>
      parseCourtIdentityWrite(JSON.stringify({ id, from: "a", to: "b" })),
    ).toThrow("Unreadable court identity log line");
  });
});
