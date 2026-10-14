import { describe, expect, test } from "bun:test";

import { SAMPLE_FACTS } from "@/features/avt/sample-case.data";
import { missingSampleFacts } from "@/features/avt/sample-case.logic";

describe("sample case", () => {
  test("an empty list needs every sample fact", () => {
    expect(missingSampleFacts(SAMPLE_FACTS, [])).toEqual([...SAMPLE_FACTS]);
  });

  test("a repeat run adds only what an earlier run left out", () => {
    const [first, second, ...rest] = SAMPLE_FACTS;
    expect(
      missingSampleFacts(SAMPLE_FACTS, [
        { name: first?.statement ?? "" },
        { name: second?.statement ?? "" },
        { name: "An unrelated fact" },
      ]),
    ).toEqual(rest);
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
