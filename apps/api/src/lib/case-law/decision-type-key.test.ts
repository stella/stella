import { expect, test } from "bun:test";

import { decisionTypeKey } from "@/api/lib/case-law/decision-type-key";

test("decision type comparison converges across casing and Unicode spellings", () => {
  expect("Nález".normalize("NFD")).not.toBe("Nález");
  for (const stated of ["Uznesenie", "Nález", "Rozsudok"]) {
    for (const variant of [
      stated,
      stated.toUpperCase(),
      ` ${stated} `,
      stated.normalize("NFD"),
    ]) {
      expect(decisionTypeKey(variant)).toBe(decisionTypeKey(stated));
      expect(decisionTypeKey(decisionTypeKey(variant))).toBe(
        decisionTypeKey(variant),
      );
    }
  }
  for (const absent of [undefined, null, "", " \t "]) {
    expect(decisionTypeKey(absent)).toBeUndefined();
  }
  expect(decisionTypeKey("Nález")).not.toBe(decisionTypeKey("Uznesenie"));
});
