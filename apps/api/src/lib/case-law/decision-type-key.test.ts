import { expect, test } from "bun:test";

import {
  DECISION_TYPE_KIND_OTHER,
  DECISION_TYPE_KINDS,
} from "@stll/api-contract/case-law-decision-types";

import {
  decisionTypeKey,
  isDocketShapedDecisionType,
} from "@/api/lib/case-law/decision-type-key";
import {
  decisionTypeFilter,
  decisionTypeKind,
  KINDED_DECISION_TYPES,
  readDecisionType,
  STATED_DECISION_TYPE_KINDS,
  statedDecisionTypesOf,
} from "@/api/lib/case-law/decision-type-kind";

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

test("a docket number is recognised as one, and no stated type looks like a docket", () => {
  for (const docket of [
    "63 az 17/2026 - 28",
    "72 ad 59/2025 - 26",
    "8 a 17/2026 - 34",
    "8 Afs 24/2025-50",
    "21 Cdo 1234/2020",
  ]) {
    expect(isDocketShapedDecisionType(docket)).toBe(true);
  }
  for (const stated of Object.keys(STATED_DECISION_TYPE_KINDS)) {
    expect(isDocketShapedDecisionType(stated)).toBe(false);
  }
});

test("odd stored values from production read as their kind or, with a reason, the catch-all", () => {
  const expected = {
    "rozs.": "judgment",
    "rozs.část.": "judgment",
    "tr.příkaz": "penal_order",
    ministery_of_justice_order: "ministry_of_justice_decision",
    ministry_of_justice_resolution: "ministry_of_justice_decision",
    "Rozsudok pre zmeškanie": "judgment",
    "Trestný rozkaz": "penal_order",
    Uznesenie: "order",
    "opatrenie bez poučenia": "court_direction",
    "elvi határozat": "principle_decision",
    "wyciąg z protokołu": "minutes_extract",
    none: "other",
    jinak: "other",
    "rozs.uzn": "other",
    // A comma inside a listed type is not a joined list.
    "průzkum, rozbor a jiné materiály": "other",
  } as const;
  for (const [stated, kind] of Object.entries(expected)) {
    expect(decisionTypeKind(stated)).toBe(kind);
  }
  expect(readDecisionType("průzkum, rozbor a jiné materiály").type).toBe(
    "mapped",
  );
});

test("a docket number stored as the type is the catch-all, never a type of its own", () => {
  expect(readDecisionType("63 az 17/2026 - 28")).toEqual({ type: "docket" });
  expect(decisionTypeKind("8 af 24/2025 - 50")).toBe(DECISION_TYPE_KIND_OTHER);
  expect(decisionTypeFilter("8 af 24/2025 - 50")).toEqual({
    type: "kind",
    kind: DECISION_TYPE_KIND_OTHER,
  });
});

test("a joined list is split and deduplicated: one kind is that kind, several are the catch-all", () => {
  expect(readDecisionType("nález,nález")).toEqual({
    type: "joined",
    kind: "finding",
  });
  expect(decisionTypeKind("uznesenie,uznesenie,uznesenie")).toBe("order");
  expect(decisionTypeKind(" Uznesenie , uznesenie ")).toBe("order");
  expect(decisionTypeKind("uznesenie,nález")).toBe(DECISION_TYPE_KIND_OTHER);
  expect(decisionTypeKind("uznesenie,zzz")).toBe(DECISION_TYPE_KIND_OTHER);
});

test("a kind's spellings include every stored casing and joined list, exactly as stored", () => {
  const order = statedDecisionTypesOf("order");
  for (const stored of ["Uznesenie", "uznesenie", "uznesenie,uznesenie"]) {
    expect(order).toContain(stored);
  }
  expect(order).not.toContain("uznesenie,nález");
  expect(KINDED_DECISION_TYPES).not.toContain("jinak");
  expect(KINDED_DECISION_TYPES).not.toContain("63 az 17/2026 - 28");
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
