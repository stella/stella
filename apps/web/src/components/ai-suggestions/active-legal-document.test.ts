import { describe, expect, test } from "bun:test";

import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";

import { activeLegalFromReaderTarget } from "./active-legal-document";

const decisionTarget: ReaderAnnotationTarget = {
  type: "decision",
  caseNumber: "22 Cdo 1234/2024",
  country: "CZ",
  court: "ns",
  decisionDate: "2024-03-01",
  decisionType: "rozsudek",
  ecli: null,
  id: "decision-1",
  name: null,
};

const statuteTarget: ReaderAnnotationTarget = {
  type: "statute",
  id: "statute-1",
  country: "CZ",
  eli: "eli/cz/sb/1964/40",
  provisionByAnchorId: new Map(),
  title: "Občanský zákoník",
  versionValidFrom: "2024-01-01",
};

describe("activeLegalFromReaderTarget", () => {
  test("sends the decision's own id, which the text is resolved by", () => {
    expect(activeLegalFromReaderTarget(decisionTarget)).toEqual({
      type: "decision",
      caseNumber: "22 Cdo 1234/2024",
      decisionId: "decision-1",
    });
  });

  test("refuses a statute, which no chat context type carries", () => {
    expect(activeLegalFromReaderTarget(statuteTarget)).toBeNull();
  });
});
