import { describe, expect, test } from "bun:test";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_FIELD_KEYS,
  DECISION_TEXT_METADATA_KEYS,
  TEXT_ABSENCE_REASONS,
} from "@stll/api-contract/case-law-text-field";

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
    const stored = storeDecisionTextFields({
      metadata: { sourceReference: "fixture-reference" },
      textFields: {
        ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        abstract: presentTextField("Published abstract"),
      },
    });

    expect(stored).toEqual({
      sourceReference: "fixture-reference",
      abstract: "Published abstract",
    });
    expect(Object.hasOwn(stored, DECISION_TEXT_ABSENCE_METADATA_KEY)).toBe(
      false,
    );
  });

  test("rejects every protected field hidden in ordinary metadata", () => {
    for (const key of DECISION_TEXT_METADATA_KEYS) {
      expect(() =>
        storeDecisionTextFields({
          metadata: { [key]: "raw value" },
          textFields: absentDecisionTextFields(
            TEXT_ABSENCE_REASON.NOT_PUBLISHED,
          ),
        }),
      ).toThrow(`Decision text must use the textFields contract: ${key}`);
    }
  });

  test("round trips every absence reason for every decision text field", () => {
    for (const key of DECISION_TEXT_FIELD_KEYS) {
      for (const reason of TEXT_ABSENCE_REASONS) {
        const textFields = {
          ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
          [key]: absentTextField(reason),
        };
        const stored = storeDecisionTextFields({
          metadata: { sourceReference: "fixture-reference" },
          textFields,
        });

        expect(readDecisionTextMetadata(stored)).toEqual({
          metadata: { sourceReference: "fixture-reference" },
          textFields,
        });
        expect(stored[DECISION_TEXT_ABSENCE_METADATA_KEY]).toEqual(
          reason === TEXT_ABSENCE_REASON.NOT_PUBLISHED
            ? undefined
            : [{ field: key, reason }],
        );
      }
    }
  });

  test("preserves stored text when a new parse fails", () => {
    expect(
      preserveStoredTextAfterParseFailure({
        incomingMetadata: {
          [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
            { field: "abstract", reason: TEXT_ABSENCE_REASON.PARSE_FAILED },
          ],
          sourceReference: "new-reference",
        },
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

  test("preserves a stored non-default absence when a new parse fails", () => {
    const storedMetadata = storeDecisionTextFields({
      metadata: { sourceReference: "stored-reference" },
      textFields: {
        ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        abstract: absentTextField(TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER),
      },
    });
    const textFields = {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      abstract: absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED),
    };
    const incomingMetadata = storeDecisionTextFields({
      metadata: { sourceReference: "new-reference" },
      textFields,
    });

    expect(
      preserveStoredTextAfterParseFailure({
        incomingMetadata,
        storedMetadata,
        textFields,
      }),
    ).toEqual({
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        {
          field: "abstract",
          reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
        },
      ],
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
    const textFields = {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      legalSentence: presentTextField("Published sentence"),
      summary: absentTextField(TEXT_ABSENCE_REASON.REDISTRIBUTION_WITHHELD),
    };
    const stored = storeDecisionTextFields({
      metadata: { sourceReference: "fixture-reference" },
      textFields,
    });

    expect(splitStoredDecisionTextMetadata(stored)).toEqual({
      metadata: { sourceReference: "fixture-reference" },
      textFields,
    });
  });

  test("fails closed when the stored absence sidecar is malformed", () => {
    const malformedSidecars = [
      null,
      "invalid",
      [{ field: "abstract", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED }],
      [
        {
          field: "abstract",
          reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
          unexpected: true,
        },
      ],
      [
        { field: "abstract", reason: TEXT_ABSENCE_REASON.PARSE_FAILED },
        {
          field: "abstract",
          reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
        },
      ],
    ];

    for (const sidecar of malformedSidecars) {
      expect(
        splitStoredDecisionTextMetadata({
          [DECISION_TEXT_ABSENCE_METADATA_KEY]: sidecar,
          abstract: "Stored abstract",
          sourceReference: "fixture-reference",
        }),
      ).toEqual({
        metadata: { sourceReference: "fixture-reference" },
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.PARSE_FAILED),
      });
    }
  });

  test("a malformed sidecar is quarantined during a failed refresh", () => {
    const textFields = {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      abstract: absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED),
    };
    const incomingMetadata = storeDecisionTextFields({
      metadata: { sourceReference: "new-reference" },
      textFields,
    });
    const malformedSidecar = [
      {
        field: "abstract",
        reason: TEXT_ABSENCE_REASON.REDISTRIBUTION_WITHHELD,
      },
      { field: "unknown", reason: TEXT_ABSENCE_REASON.PARSE_FAILED },
    ];

    const preserved = preserveStoredTextAfterParseFailure({
      incomingMetadata,
      storedMetadata: {
        [DECISION_TEXT_ABSENCE_METADATA_KEY]: malformedSidecar,
        abstract: "Restricted text",
      },
      textFields,
    });

    expect(preserved).toEqual({
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        { field: "abstract", reason: TEXT_ABSENCE_REASON.PARSE_FAILED },
      ],
      abstract: "Restricted text",
      sourceReference: "new-reference",
    });
    expect(readDecisionTextMetadata(preserved).textFields.abstract).toEqual(
      absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED),
    );

    expect(
      preserveStoredTextAfterParseFailure({
        incomingMetadata,
        storedMetadata: preserved,
        textFields,
      }),
    ).toEqual(preserved);
  });

  test("a successful refresh replaces malformed stored text state", () => {
    const textFields = {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      abstract: presentTextField("Current abstract"),
    };
    const incomingMetadata = storeDecisionTextFields({
      metadata: { sourceReference: "new-reference" },
      textFields,
    });

    expect(
      preserveStoredTextAfterParseFailure({
        incomingMetadata,
        storedMetadata: {
          [DECISION_TEXT_ABSENCE_METADATA_KEY]: "malformed",
          abstract: "Untrusted stored text",
        },
        textFields,
      }),
    ).toEqual({
      abstract: "Current abstract",
      sourceReference: "new-reference",
    });
  });

  test("an explicit stored absence wins over a contradictory text value", () => {
    expect(
      readDecisionTextMetadata({
        [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
          {
            field: "abstract",
            reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
          },
        ],
        abstract: "Contradictory text",
      }).textFields.abstract,
    ).toEqual(absentTextField(TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER));
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
