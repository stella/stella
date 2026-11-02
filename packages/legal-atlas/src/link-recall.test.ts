import { describe, expect, test } from "bun:test";

import {
  compareAuditReferences,
  storedDecisionAuditReferences,
} from "./link-recall";
import {
  CZ_REFERENCE_AUDIT_PROFILE,
  extractAuditReferences,
} from "./link-recall-reference";

const references = () =>
  extractAuditReferences({
    profile: CZ_REFERENCE_AUDIT_PROFILE,
    passages: [
      {
        anchor: "opening",
        text: "Nejvyšší správní soud rozhodl o kasační stížnosti proti rozsudku Krajského soudu v Ostravě ze dne 30. 1. 2025, č. j. 25 A 20/2024-35.",
      },
    ],
    selfIdentifiers: ["7 As 32/2025-30"],
  });

describe("independent link recall", () => {
  test("detects a reviewed decision even when every production quality gate is silent", () => {
    const result = compareAuditReferences({
      references: references(),
      stored: [],
    });
    expect(
      result.targets.find(({ kind }) => kind === "reviewed-decision"),
    ).toEqual({
      kind: "reviewed-decision",
      key: "25A20/2024",
      extracted: false,
      linked: false,
    });
    expect(
      result.misses.every(
        ({ anchor, text }) =>
          anchor === "opening" && text.includes("25 A 20/2024-35"),
      ),
    ).toBe(true);
  });

  test("metadata and unresolved rows do not inflate link recall", () => {
    for (const status of ["metadata", "extracted"] as const) {
      const result = compareAuditReferences({
        references: references(),
        stored: [{ kind: "reviewed-decision", key: "25A20/2024", status }],
      });
      expect(
        result.targets.find(({ kind }) => kind === "reviewed-decision"),
      ).toMatchObject({ extracted: true, linked: false });
    }
  });

  test("a precedent link does not establish the reviewed relationship", () => {
    const precedent = compareAuditReferences({
      references: references(),
      stored: storedDecisionAuditReferences({
        text: "25 A 20/2024",
        kind: "precedent",
        status: "linked",
      }),
    });
    expect(
      precedent.targets.find(({ kind }) => kind === "decision")?.linked,
    ).toBe(true);
    expect(
      precedent.targets.find(({ kind }) => kind === "reviewed-decision")
        ?.linked,
    ).toBe(false);
    const procedural = compareAuditReferences({
      references: references(),
      stored: storedDecisionAuditReferences({
        text: "25 A 20/2024",
        kind: "procedural",
        status: "linked",
      }),
    });
    expect(procedural.targets.every(({ linked }) => linked)).toBe(true);
  });

  test("counts each target once while retaining every missed passage", () => {
    const repeated = references().flatMap((reference) => [
      reference,
      { ...reference, anchor: "history" },
    ]);
    const result = compareAuditReferences({ references: repeated, stored: [] });
    expect(result.targets).toHaveLength(references().length);
    expect(result.misses).toHaveLength(references().length * 2);
  });
});
