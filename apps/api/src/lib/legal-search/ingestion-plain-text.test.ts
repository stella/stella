import { describe, expect, test } from "bun:test";

import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  presentTextField,
} from "@/api/lib/case-law/decision-text";
import { PlainTextError } from "@/api/lib/case-law/plain-text";
import {
  EMPTY_AST,
  plainTextIngestionResult,
  type IngestionResult,
} from "@/api/lib/legal-search/ingestion-types";

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
    expect(result.caseNumber).toBe("A 1");
    expect(result.court).toBe("Court name");
    expect(result.metadata).toEqual({ title: "Decision", nested: ["Value"] });
    expect(plainTextIngestionResult(result)).toEqual(result);
  });

  test("markup alone cannot turn published text into a present empty field", () => {
    expect(() =>
      plainTextIngestionResult({
        ...rawDecision,
        textFields: {
          ...rawDecision.textFields,
          headnote: presentTextField("<br/><!-- nothing -->"),
        },
      }),
    ).toThrow(PlainTextError);
  });

  test("raw labels and metadata cannot satisfy the ingestion contract", () => {
    // @ts-expect-error A source string must cross the plain-text constructor.
    const rawCaseNumber: IngestionResult["caseNumber"] = "A <br/> 1";
    // @ts-expect-error Recursive metadata strings must cross the same boundary.
    const rawMetadata: IngestionResult["metadata"] = {
      title: "<b>Decision</b>",
    };
    const result = plainTextIngestionResult({
      ...rawDecision,
      caseNumber: rawCaseNumber,
      metadata: rawMetadata,
    });
    expect(result.caseNumber).toBe("A 1");
    expect(result.metadata).toEqual({ title: "Decision" });
  });
});
