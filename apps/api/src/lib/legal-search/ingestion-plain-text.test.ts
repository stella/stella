import { describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  presentTextField,
} from "@/api/lib/case-law/decision-text";
import { PlainTextError } from "@/api/lib/case-law/plain-text";
import {
  toPlainTextIngestionResult,
  EMPTY_AST,
  type IngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";

const rawDecision = {
  caseNumber: "A <br/> 1",
  court: "Court <span>name</span>",
  country: "SVK",
  language: "sk",
  metadata: { title: "<b>Decision</b>", nested: ["&amp;lt;br/&amp;gt;Value"] },
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  rawHash: "fixture",
  documentAst: EMPTY_AST,
};

describe("publisher labels cross one structural text boundary", () => {
  test("all label and nested metadata transformations are a fixed point", () => {
    const result = plainTextIngestionResult(rawDecision);
    expect(result.caseNumber === "A 1").toBe(true);
    expect(result.court === "Court name").toBe(true);
    expect(
      Bun.deepEquals(result.metadata, { title: "Decision", nested: ["Value"] }),
    ).toBe(true);
    expect(result.plainTextOutcome.type).toBe("accepted");
    expect(plainTextIngestionResult(result)).toEqual(result);
  });

  test("optional labels, judges, citations and every present text field cross the same boundary", () => {
    const encoded = "&amp;lt;b&amp;gt;Value&amp;lt;/b&amp;gt;";
    const result = toPlainTextIngestionResult({
      ...rawDecision,
      sheetNumber: encoded,
      ecli: encoded,
      legacyEcli: encoded,
      decisionType: encoded,
      judges: [{ role: "rapporteur", nameAsPrinted: encoded }],
      publisherCitedCases: [encoded],
      identifiers: [
        { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: encoded },
      ],
      textFields: {
        abstract: presentTextField(encoded),
        headnote: presentTextField(encoded),
        legalSentence: presentTextField(encoded),
        summary: presentTextField(encoded),
      },
    }).unwrap();
    for (const label of [
      result.sheetNumber,
      result.ecli,
      result.legacyEcli,
      result.decisionType,
      result.judges?.at(0)?.nameAsPrinted,
      result.publisherCitedCases?.at(0),
      result.identifiers?.at(0)?.value,
    ]) {
      expect(label?.toString()).toBe("Value");
    }
    for (const field of Object.values(result.textFields)) {
      expect(field).toMatchObject({ type: "present", text: "Value" });
    }
    expect(toPlainTextIngestionResult(result).unwrap()).toEqual(result);
  });

  test("markup alone cannot turn published text into a present empty field", () => {
    const decision = plainTextIngestionResult({
      ...rawDecision,
      textFields: {
        ...rawDecision.textFields,
        headnote: presentTextField("<br/><!-- nothing -->"),
      },
    });
    expect(decision.plainTextOutcome.type).toBe("item_build_failed");
    if (decision.plainTextOutcome.type === "item_build_failed") {
      expect(decision.plainTextOutcome.error).toBeInstanceOf(PlainTextError);
      expect(decision.plainTextOutcome.error.reason).toBe("empty-present-text");
    }
    expect(decision.isListingOnly).toBe(true);
    expect(decision.textFields.headnote.type).toBe("absent");
  });

  test.each(["caseNumber", "court"] as const)(
    "markup-only %s is rejected while an absent label remains absent",
    (field) => {
      const rejected = toPlainTextIngestionResult({
        ...rawDecision,
        [field]: "<p></p>",
      });
      expect(rejected.isErr()).toBe(true);
      if (rejected.isErr()) {
        expect(rejected.error.reason).toBe("empty-present-text");
      }
      const absent = toPlainTextIngestionResult({
        ...rawDecision,
        [field]: "",
      }).unwrap();
      expect(absent[field].toString()).toBe("");
    },
  );

  test("rejected labels keep raw document evidence and replay to the same quarantine", () => {
    const sourceRawBytes = new Uint8Array([1, 2, 3]);
    const sourceRawObjects = {
      document: { bytes: sourceRawBytes, contentType: "application/pdf" },
    };
    for (const sourceDocumentId of [
      "publisher-id",
      undefined,
      "too-long".repeat(40),
      "id\u0000",
      "id\u00a0",
    ]) {
      const raw = {
        ...rawDecision,
        sourceDocumentId,
        metadata: { label: "\\rtf1 rejected" },
        sourceRaw: "exact raw publisher response",
        sourceRawContentType: "text/plain",
        sourceRawBytes,
        sourceRawObjects,
        sourceUrl: "https://publisher.example/decision/1",
        documentUrl: "https://publisher.example/decision/1.pdf",
        fulltext: "Published document",
      };
      const decision = plainTextIngestionResult(raw);
      expect(decision.plainTextOutcome.type).toBe("item_build_failed");
      expect(decision.sourceDocumentId === "publisher-id").toBe(
        sourceDocumentId === "publisher-id",
      );
      expect(decision.caseNumber.startsWith("plaintext-quarantine:")).toBe(
        true,
      );
      expect(decision.court.length).toBe(0);
      expect(decision.sourceRaw).toBe(raw.sourceRaw);
      expect(decision.sourceRawContentType).toBe(raw.sourceRawContentType);
      expect(decision.sourceRawBytes).toBe(sourceRawBytes);
      expect(decision.sourceRawObjects).toBe(sourceRawObjects);
      expect(decision.sourceUrl).toBe(raw.sourceUrl);
      expect(decision.documentUrl).toBe(raw.documentUrl);
      expect(decision.fulltext).toBeUndefined();
      expect(decision.documentDelivery).toBeUndefined();
      expect(Bun.deepEquals(plainTextIngestionResult(decision), decision)).toBe(
        true,
      );
    }
  });

  test("empty raw captures retain distinct content-addressed quarantine identities", () => {
    const first = plainTextIngestionResult({
      ...rawDecision,
      metadata: { label: "\\rtf1" },
      sourceRaw: "",
      rawHash: "first-content",
    });
    const second = plainTextIngestionResult({
      ...rawDecision,
      metadata: { label: "\\rtf1" },
      sourceRaw: "",
      rawHash: "second-content",
    });
    expect(first.sourceDocumentId === second.sourceDocumentId).toBe(false);
    expect(first.plainTextOutcome.type).toBe("item_build_failed");
    expect(second.plainTextOutcome.type).toBe("item_build_failed");
  });

  test("raw labels and metadata cannot satisfy the ingestion contract", () => {
    // @ts-expect-error A source string must cross the plain-text constructor.
    const rawCaseNumber: IngestionResult["caseNumber"] = "A <br/> 1";
    const rawMetadata: IngestionResult["metadata"] = {
      // @ts-expect-error Recursive metadata strings must cross the same boundary.
      title: "<b>Decision</b>",
    };
    const result = plainTextIngestionResult({
      ...rawDecision,
      caseNumber: rawCaseNumber,
      metadata: rawMetadata,
    });
    expect(result.caseNumber === "A 1").toBe(true);
    expect(Bun.deepEquals(result.metadata, { title: "Decision" })).toBe(true);
  });
});
