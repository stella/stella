import { describe, expect, test } from "bun:test";

import {
  INTERPRETATION_SCENARIOS,
  scoreInterpretation,
} from "./legal-interpretation-score";
import type { InterpretationCall } from "./legal-interpretation-score";

const scenario = INTERPRETATION_SCENARIOS[0];
const text =
  "Conclusion: the reading is open. Language and system support alternative readings. History is unavailable; purpose is uncertain. Confidence is open. No relevant case law was found. No jurisdiction-specific overlay is available.";
const search: InterpretationCall = {
  name: "search_case_law",
  input: { queries: [] },
  accepted: true,
  discovered: [],
  read: [],
};
const citation = "ECLI:CZ:TEST:2026:123";

describe("interpretation evidence boundaries", () => {
  test("requires an accepted search, methodological structure and limitations", () => {
    expect(
      scoreInterpretation({
        overlayAvailable: false,
        scenario,
        text,
        calls: [search],
      }),
    ).toEqual([]);
    expect(
      scoreInterpretation({
        overlayAvailable: false,
        scenario,
        text,
        calls: [],
      }),
    ).toContain("no accepted case-law search");
    expect(
      scoreInterpretation({
        overlayAvailable: false,
        scenario,
        text: "Conclusion: yes.",
        calls: [search],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      scoreInterpretation({
        overlayAvailable: false,
        scenario,
        text,
        calls: [{ ...search, accepted: false }],
      }),
    ).toContain("rejected tool call");
  });
  test("a citation requires discovery before successful reading", () => {
    const answer = `${text} ${citation}`;
    const read: InterpretationCall = {
      name: "read_case_law_decision",
      input: {},
      accepted: true,
      discovered: [],
      read: [citation],
    };
    const discovered = { ...search, discovered: [citation] };
    for (const calls of [[search], [discovered], [read, discovered]]) {
      expect(
        scoreInterpretation({
          overlayAvailable: false,
          scenario,
          text: answer,
          calls,
        }),
      ).toContain(`unverified decision citation: ${citation}`);
    }
    expect(
      scoreInterpretation({
        overlayAvailable: false,
        scenario,
        text: answer,
        calls: [discovered, read],
      }),
    ).toEqual([]);
  });
  test("unread dockets and uncited read authorities fail", () => {
    const docket = "1 Test 123/2026";
    expect(
      scoreInterpretation({
        overlayAvailable: false,
        scenario,
        text: `${text} ${docket}`,
        calls: [search],
      }),
    ).toContain(`unverified decision citation: ${docket}`);
    const discovered = { ...search, discovered: [citation] };
    const read = {
      ...search,
      name: "read_case_law_decision",
      read: [citation],
    };
    expect(
      scoreInterpretation({
        overlayAvailable: false,
        scenario,
        text,
        calls: [discovered, read],
      }),
    ).toContain("missing official citation for read authority");
  });

  test("all seven cases exercise their distinct behavioral requirement", () => {
    const additions = {
      methods: "",
      coverage: "Application: electric scooter.",
      conflict: "Tension resolved by priority and limits.",
      contract: "The parties' common intent applies under Czech law.",
      "no-case-law": "",
      "no-overlay": "No jurisdiction-specific overlay is available.",
      provenance: "",
    };
    expect(INTERPRETATION_SCENARIOS).toHaveLength(7);
    for (const current of INTERPRETATION_SCENARIOS) {
      expect(
        scoreInterpretation({
          overlayAvailable: false,
          scenario: current,
          text: `${text} ${additions[current.requirement]}`,
          calls: [search],
        }),
      ).toEqual([]);
    }
  });
});
