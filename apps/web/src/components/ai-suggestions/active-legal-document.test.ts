import { describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";

import {
  activeLegalDocumentRef,
  activeLegalFromReaderTarget,
} from "./active-legal-document";

const decisionTarget: ReaderAnnotationTarget = {
  type: "decision",
  caseNumber: "22 Cdo 1234/2024",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
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

  test("sends the consolidation's own id, which its provisions are selected from", () => {
    expect(activeLegalFromReaderTarget(statuteTarget)).toEqual({
      type: "statute",
      documentId: "statute-1",
      title: "Občanský zákoník",
    });
  });
});

describe("what the surfaces around the composer read off the document", () => {
  test("names a decision by its case number, under its own key", () => {
    expect(
      activeLegalDocumentRef(activeLegalFromReaderTarget(decisionTarget)),
    ).toEqual({ key: "decision:decision-1", label: "22 Cdo 1234/2024" });
  });

  test("names a consolidation by the act's title, under its own key", () => {
    expect(
      activeLegalDocumentRef(activeLegalFromReaderTarget(statuteTarget)),
    ).toEqual({ key: "statute:statute-1", label: "Občanský zákoník" });
  });
});
