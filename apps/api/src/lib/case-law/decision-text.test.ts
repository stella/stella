import { describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  absentTextField,
  presentTextField,
  preserveStoredTextAfterParseFailure,
  readDecisionHeadnote,
  readDecisionTextMetadata,
  readTextField,
  sourceTextField,
  splitStoredDecisionTextMetadata,
  storeDecisionTextFields,
  storeTextField,
} from "@/api/lib/case-law/decision-text";

describe("decision text fields", () => {
  test("preserve published text through storage and reads", () => {
    const field = sourceTextField(
      ADAPTER_KEYS.CZ_US,
      "  First paragraph.\n\n  Second paragraph.  ",
    );

    expect(field).toEqual({
      type: "present",
      text: "First paragraph.\n\n  Second paragraph.",
    });
    expect(readTextField(storeTextField(field))).toEqual(field);
  });

  test("distinguish an empty source field from a declared placeholder", () => {
    expect(sourceTextField(ADAPTER_KEYS.CZ_US, " \n\t ")).toEqual({
      type: "absent",
      reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
    });
    expect(
      sourceTextField(ADAPTER_KEYS.CZ_US, "Právní věta není k dispozici."),
    ).toEqual({
      type: "absent",
      reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
    });
  });

  test("store absence as the existing nullable representation", () => {
    const absent = absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED);

    expect(storeTextField(absent)).toBeUndefined();
    expect(readTextField(null)).toEqual({
      type: "absent",
      reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
    });
  });

  test("reject an empty present branch", () => {
    expect(() => presentTextField("  ")).toThrow(
      "Present decision text must contain text",
    );
  });

  test("stores declared fields separately from ordinary metadata", () => {
    expect(
      storeDecisionTextFields({
        metadata: { sourceReference: "fixture-reference" },
        textFields: {
          ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
          abstract: presentTextField("Published abstract"),
        },
      }),
    ).toEqual({
      sourceReference: "fixture-reference",
      abstract: "Published abstract",
    });
  });

  test("rejects a protected field hidden in ordinary metadata", () => {
    expect(() =>
      storeDecisionTextFields({
        metadata: { summary: "raw text" },
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      }),
    ).toThrow("Decision text must use the textFields contract: summary");
  });

  test("preserves stored text when a new parse fails", () => {
    expect(
      preserveStoredTextAfterParseFailure({
        incomingMetadata: { sourceReference: "new-reference" },
        storedMetadata: {
          abstract: "Stored abstract",
          sourceReference: "stored-reference",
        },
        textFields: {
          ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
          abstract: absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED),
        },
      }),
    ).toEqual({
      abstract: "Stored abstract",
      sourceReference: "new-reference",
    });
  });

  test("reads stored decision text into explicit response values", () => {
    expect(
      readDecisionTextMetadata({
        abstract: "Published abstract",
        sourceReference: "fixture-reference",
        summary: null,
      }),
    ).toEqual({
      metadata: { sourceReference: "fixture-reference" },
      textFields: {
        abstract: presentTextField("Published abstract"),
        headnote: absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        legalSentence: absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        summary: absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      },
    });
  });

  test("splits stored text before replaying an ingestion result", () => {
    expect(
      splitStoredDecisionTextMetadata({
        sourceReference: "fixture-reference",
        legalSentence: "Published sentence",
      }),
    ).toEqual({
      metadata: { sourceReference: "fixture-reference" },
      textFields: {
        ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        legalSentence: presentTextField("Published sentence"),
      },
    });
  });

  test("reports an invalid stored value as a parse failure", () => {
    expect(readTextField(["not", "text"])).toEqual({
      type: "absent",
      reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
    });
    expect(readDecisionHeadnote("  ")).toEqual({
      type: "absent",
      reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
    });
  });
});
