import { expect, test } from "bun:test";

import {
  DECISION_TYPE_KIND_OTHER,
  DECISION_TYPE_KINDS,
} from "@stll/api-contract/case-law-decision-types";

import {
  decisionTypeFilter,
  decisionTypeKey,
  decisionTypeKind,
  STATED_DECISION_TYPE_KINDS,
  statedDecisionTypesOf,
} from "@/api/lib/case-law/decision-type-key";

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

test("an abbreviation and a casing of one stated type fold into its canonical kind", () => {
  expect("usnesení".normalize("NFD")).not.toBe("usnesení");
  for (const stated of [
    "usn.",
    "Usn.",
    " USN. ",
    "usnesení",
    "Usnesení",
    "usnesení".normalize("NFD"),
  ]) {
    expect(decisionTypeKind(stated)).toBe("order");
  }
  expect(decisionTypeKind("rozsudek")).toBe("judgment");
  expect(decisionTypeKind("ministery_of_justice_decision")).toBe(
    "ministry_of_justice_decision",
  );
});

test("a stated type no kind claims, or none at all, is the catch-all kind", () => {
  for (const stated of ["jiné", "zzz", "", null, undefined]) {
    expect(decisionTypeKind(stated)).toBe(DECISION_TYPE_KIND_OTHER);
  }
});

// Spellings are listed in stored form (ingestion lowercases every type), so
// each is its own comparison key and no two can fold onto different kinds.
test("every listed spelling is in stored form and reads as its own kind", () => {
  for (const [stated, kind] of Object.entries(STATED_DECISION_TYPE_KINDS)) {
    expect(decisionTypeKey(stated)).toBe(stated);
    expect(decisionTypeKind(stated)).toBe(kind);
  }
  // A kind that is also a stated spelling (`order`, `judgment`) must name
  // itself, or a filter by kind and a filter by that spelling would differ.
  for (const kind of DECISION_TYPE_KINDS) {
    if (Object.hasOwn(STATED_DECISION_TYPE_KINDS, kind)) {
      expect(decisionTypeKind(kind)).toBe(kind);
    }
  }
});

test("a filter by kind, by any spelling of it, or by its abbreviation selects the same kind", () => {
  for (const requested of ["order", "usnesení", "Usnesení", "usn.", "Usn."]) {
    expect(decisionTypeFilter(requested)).toEqual({
      type: "kind",
      kind: "order",
    });
  }
  expect(decisionTypeFilter(DECISION_TYPE_KIND_OTHER)).toEqual({
    type: "kind",
    kind: DECISION_TYPE_KIND_OTHER,
  });
  expect(decisionTypeFilter("Jiné")).toEqual({
    type: "stated",
    stated: "Jiné",
  });
  expect(statedDecisionTypesOf("order")).toEqual(
    expect.arrayContaining(["usnesení", "usn.", "uznesenie", "postanowienie"]),
  );
  expect(statedDecisionTypesOf("order")).not.toContain("rozsudek");
});
