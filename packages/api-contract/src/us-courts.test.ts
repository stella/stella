import { describe, expect, test } from "bun:test";

import {
  resolveUsCourt,
  US_COURT_NAMES,
  US_COURT_SYSTEMS,
  US_COURT_TIERS,
  US_COURTS,
} from "./us-courts";

describe("the United States court directory", () => {
  test("an enrolled court resolves to its canonical entry", () => {
    expect(resolveUsCourt("scotus")).toEqual({
      type: "enrolled",
      court: {
        id: "scotus",
        name: "Supreme Court of the United States",
        system: "federal",
        tier: "supreme",
      },
    });
  });

  test("any other court is rejected, spellings of an enrolled one included", () => {
    for (const courtId of [
      "SCOTUS",
      " scotus",
      "scotus ",
      "Supreme Court of the United States",
      "ca9",
      "cadc",
      "nysd",
      "cal",
      "",
    ]) {
      expect(resolveUsCourt(courtId)).toEqual({ type: "rejected", courtId });
    }
  });

  test("ids and names are each unique, so one court has one tag value", () => {
    const ids = US_COURTS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(US_COURT_NAMES).size).toBe(US_COURTS.length);
    expect(US_COURT_NAMES).toEqual(US_COURTS.map(({ name }) => name));
  });

  test("every entry resolves to itself and uses a declared system and tier", () => {
    for (const court of US_COURTS) {
      expect(resolveUsCourt(court.id)).toEqual({ type: "enrolled", court });
      expect(US_COURT_SYSTEMS).toContain(court.system);
      expect(US_COURT_TIERS).toContain(court.tier);
    }
  });
});
