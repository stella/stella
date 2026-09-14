import { describe, expect, test } from "bun:test";

import { getOrsrCourtName, getOrsrCourtNameGenitive } from "./court-names.js";

// Insert code, nominative, genitive. The genitive is the wording the register
// prints in its own extract header ("Výpis z Obchodného registra …").
const KNOWN_COURTS = [
  ["B", "Mestský súd Bratislava III", "Mestského súdu Bratislava III"],
  ["T", "Okresný súd Trnava", "Okresného súdu Trnava"],
  ["R", "Okresný súd Trenčín", "Okresného súdu Trenčín"],
  ["N", "Okresný súd Nitra", "Okresného súdu Nitra"],
  ["L", "Okresný súd Žilina", "Okresného súdu Žilina"],
  ["S", "Okresný súd Banská Bystrica", "Okresného súdu Banská Bystrica"],
  ["P", "Okresný súd Prešov", "Okresného súdu Prešov"],
  ["V", "Mestský súd Košice", "Mestského súdu Košice"],
] as const;

describe("ORSR court names", () => {
  test.each(KNOWN_COURTS)(
    "%s resolves its nominative and genitive names",
    (code, nominative, genitive) => {
      expect(getOrsrCourtName(code)).toBe(nominative);
      expect(getOrsrCourtNameGenitive(code)).toBe(genitive);
      expect(getOrsrCourtNameGenitive(nominative)).toBe(genitive);
    },
  );

  test.each([
    "unknown",
    "toString",
    "constructor",
    "__proto__",
    // Pre-2023 names the court map replaced: inflecting them would put a
    // court that no longer exists into a contract.
    "Okresný súd Bratislava I",
    "Okresný súd Košice I",
  ])("%s is not treated as a known court", (court) => {
    expect(getOrsrCourtName(court)).toBe(court);
    expect(getOrsrCourtNameGenitive(court)).toBeNull();
  });
});
