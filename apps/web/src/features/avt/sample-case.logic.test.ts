import { describe, expect, test } from "bun:test";

import { SAMPLE_FACTS } from "@/features/avt/sample-case.data";
import { sampleFactWrites } from "@/features/avt/sample-case.logic";

const DETAILS = { confidence: "high" };

describe("sample case", () => {
  test("an empty list needs every sample fact", () => {
    expect(sampleFactWrites(SAMPLE_FACTS, [])).toEqual({
      create: [...SAMPLE_FACTS],
      completeDetails: [],
    });
  });

  test("a repeat run creates only facts an earlier run left out", () => {
    const [first, second, ...rest] = SAMPLE_FACTS;
    expect(
      sampleFactWrites(SAMPLE_FACTS, [
        { id: "a", name: first?.statement ?? "", factDetails: DETAILS },
        { id: "b", name: second?.statement ?? "", factDetails: DETAILS },
        { id: "c", name: "An unrelated fact", factDetails: null },
      ]),
    ).toEqual({ create: rest, completeDetails: [] });
  });

  test("a fact created without its detail gets the detail, not a duplicate", () => {
    const createdOnly = SAMPLE_FACTS.slice(0, 1);
    const writes = sampleFactWrites(
      SAMPLE_FACTS,
      createdOnly.map((fact) => ({
        id: "created-only",
        name: fact.statement,
        factDetails: null,
      })),
    );
    expect(writes.create).toEqual(SAMPLE_FACTS.slice(1));
    expect(writes.completeDetails).toEqual(
      createdOnly.map((fact) => ({ fact, itemEntityId: "created-only" })),
    );
  });

  test("statements carry no metadata prefix and stay unique", () => {
    const statements = SAMPLE_FACTS.map((fact) => fact.statement);
    expect(new Set(statements).size).toBe(statements.length);
    for (const statement of statements) {
      expect(statement).not.toMatch(/^[A-Z]+-\d+/u);
    }
  });

  test("low-confidence facts are held out and every other fact is scored", () => {
    for (const { details } of SAMPLE_FACTS) {
      expect(details.scoring).toBe(
        details.confidence === "low" ? "held" : "included",
      );
    }
  });
});
