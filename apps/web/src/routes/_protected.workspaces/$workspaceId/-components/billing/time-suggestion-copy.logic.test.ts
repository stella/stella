import { describe, expect, test } from "bun:test";

import type { TimeEntrySuggestionEvidence } from "@stll/api-contract/time-entry-types";

import {
  composeSuggestionNarrative,
  suggestionEvidenceLabels,
} from "./time-suggestion-copy.logic";

const labels = {
  chatEvidence: (count: number, title: string) => `${count} in ${title}`,
  unnamedRecord: "Matter record",
};

const evidence: TimeEntrySuggestionEvidence[] = [
  {
    type: "chat_thread",
    id: "t1",
    title: " Lease negotiation ",
    messageCount: 2,
  },
  {
    type: "resource",
    id: "d1",
    resourceType: "entity",
    name: "Lease v2",
    actions: ["update"],
  },
  {
    type: "chat_thread",
    id: "t2",
    title: "Lease negotiation",
    messageCount: 1,
  },
  {
    type: "resource",
    id: "d2",
    resourceType: "work_obligation",
    name: null,
    actions: ["create"],
  },
];

describe("composeSuggestionNarrative", () => {
  test("names each conversation and record once, trimmed, falling back for unnamed records", () => {
    expect(composeSuggestionNarrative(evidence, labels)).toBe(
      "Lease negotiation; Lease v2; Matter record",
    );
  });

  test("yields an empty narrative for empty evidence", () => {
    expect(composeSuggestionNarrative([], labels)).toBe("");
  });
});

describe("suggestionEvidenceLabels", () => {
  test("keeps one label per evidence item in day order", () => {
    expect(suggestionEvidenceLabels(evidence, labels)).toEqual([
      "2 in  Lease negotiation ",
      "Lease v2",
      "1 in Lease negotiation",
      "Matter record",
    ]);
  });
});
