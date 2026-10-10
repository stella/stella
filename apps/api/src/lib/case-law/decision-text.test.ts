import { describe, expect, test } from "bun:test";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
  DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
  DECISION_TEXT_FIELD_KEYS,
  DECISION_TEXT_METADATA_KEYS,
  TEXT_ABSENCE_REASONS,
  type DecisionTextFieldKey,
} from "@stll/api-contract/case-law-text-field";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  absentTextField,
  checkedDecisionMetadata,
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
import {
  MAX_METADATA_URL_DIAGNOSTICS,
  META_URL_DIAGNOSTICS,
} from "@/api/lib/legal-search/metadata-urls";
import { toMetadataUrl } from "@/api/lib/sanitize-url";
import { isRecord } from "@/api/lib/type-guards";

test("publisher metadata cannot collide with generated URL diagnostics", () => {
  for (const value of [
    undefined,
    null,
    [],
    { entries: [], overflow: 0 },
    "publisher value",
  ]) {
    expect(() =>
      checkedDecisionMetadata({ [META_URL_DIAGNOSTICS]: value }),
    ).toThrow(
      `Publisher metadata cannot use the reserved key: ${META_URL_DIAGNOSTICS}`,
    );
  }
  expect(checkedDecisionMetadata({ publisher: "Source" })).toEqual({
    publisher: "Source",
  });
});

test("URL metadata provenance is explicit at the checked boundary", () => {
  const schema = { url: "url" } as const;
  expect(() =>
    checkedDecisionMetadata(
      {
        url: toMetadataUrl("https://example.test/", "decoded"),
        [META_URL_DIAGNOSTICS]: { entries: [], overflowCount: 0 },
      },
      schema,
    ),
  ).toThrow(
    `Publisher metadata cannot use the reserved key: ${META_URL_DIAGNOSTICS}`,
  );
  const generated = checkedDecisionMetadata(
    { url: toMetadataUrl("ftp://example.test/", "decoded") },
    schema,
  );
  expect(
    checkedDecisionMetadata(generated, { type: "stored", schema }),
  ).toEqual(generated);
  const current = checkedDecisionMetadata(
    {
      url: "https://example.test/?stated=&amp;",
      [META_URL_DIAGNOSTICS]: {
        entries: [
          { address: "url", reason: "unsafe-protocol" },
          ...Array.from(
            { length: MAX_METADATA_URL_DIAGNOSTICS + 3 },
            (_, index) => ({
              address: `missing[${index}]`,
              reason: "invalid-url",
            }),
          ),
        ],
        overflowCount: 0,
      },
    },
    { type: "stored", schema },
  );
  expect(current["url"]).toBe("https://example.test/?stated=&amp;");
  const diagnostics = current[META_URL_DIAGNOSTICS];
  if (!isRecord(diagnostics) || !Array.isArray(diagnostics["entries"])) {
    throw new TypeError("Expected validated diagnostic sidecar");
  }
  expect(diagnostics["entries"].length).toBeLessThanOrEqual(
    MAX_METADATA_URL_DIAGNOSTICS,
  );
  expect(
    diagnostics["entries"].some(
      (entry) => isRecord(entry) && entry["address"] === "url",
    ),
  ).toBe(false);
});

test("generated URL diagnostics survive internal storage and replay but are absent from public metadata", () => {
  const diagnostics = {
    entries: [{ address: "source.href", reason: "invalid-url" }],
    overflowCount: 3,
  };
  const stored = storeDecisionTextFields({
    metadata: { publisher: "Source", [META_URL_DIAGNOSTICS]: diagnostics },
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  });
  expect(stored[META_URL_DIAGNOSTICS]).toEqual(diagnostics);
  expect(
    splitStoredDecisionTextMetadata(stored).metadata[META_URL_DIAGNOSTICS],
  ).toEqual(diagnostics);
  expect(readDecisionTextMetadata(stored).metadata).toEqual({
    publisher: "Source",
  });
  expect(stored[META_URL_DIAGNOSTICS]).toEqual(diagnostics);
});

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

  test("read punctuation, filler tokens and repeats as a placeholder", () => {
    for (const filler of ["-", "—", " … ", "(...)", "N/A", "null", "xxx"]) {
      expect(sourceTextField(ADAPTER_KEYS.CZ_NSS, filler)).toEqual({
        type: "absent",
        reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
      });
    }
  });

  test("keep short and non-Latin publisher text", () => {
    const headnote =
      "Soud nemůže zamítnout návrh jen proto, že navrhovatel neoznačil důkaz.";
    for (const text of [headnote, "A", "§ 5", "判決", "Суд", "٣"]) {
      expect(sourceTextField(ADAPTER_KEYS.CZ_NSS, text)).toEqual({
        type: "present",
        text,
      });
    }
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

  test("stores every absent field reason beside ordinary metadata", () => {
    const stored = storeDecisionTextFields({
      metadata: { sourceReference: "fixture-reference" },
      textFields: {
        ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        abstract: presentTextField("Published abstract"),
      },
    });

    expect(stored).toEqual({
      sourceReference: "fixture-reference",
      [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
        DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        { field: "headnote", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "legalSentence", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "summary", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
      ],
      abstract: "Published abstract",
    });
  });

  test("stores no absence sidecar when every text field is present", () => {
    const textFields = {
      abstract: presentTextField("Published abstract"),
      headnote: presentTextField("Published headnote"),
      legalSentence: presentTextField("Published sentence"),
      summary: presentTextField("Published summary"),
    };

    const stored = storeDecisionTextFields({
      metadata: { sourceReference: "fixture-reference" },
      textFields,
    });

    expect(stored).toEqual({
      sourceReference: "fixture-reference",
      [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
        DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
      abstract: "Published abstract",
      headnote: "Published headnote",
      legalSentence: "Published sentence",
      summary: "Published summary",
    });
    expect(Object.hasOwn(stored, DECISION_TEXT_ABSENCE_METADATA_KEY)).toBe(
      false,
    );
    expect(readDecisionTextMetadata(stored).textFields).toEqual(textFields);
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

  test("stores every text state mask and round trips its exact stored form", () => {
    const presentText = {
      abstract: "Abstract first line\nsecond  line",
      headnote: "Headnote first line\nsecond  line",
      legalSentence: "Sentence first line\nsecond  line",
      summary: "Summary first line\nsecond  line",
    } satisfies Record<DecisionTextFieldKey, string>;
    const isAbsent = (mask: number, field: DecisionTextFieldKey): boolean => {
      const index = DECISION_TEXT_FIELD_KEYS.indexOf(field);
      return Math.floor(mask / 2 ** index) % 2 === 1;
    };

    for (let mask = 0; mask < 2 ** DECISION_TEXT_FIELD_KEYS.length; mask += 1) {
      for (const reason of TEXT_ABSENCE_REASONS) {
        const textFields = {
          abstract: isAbsent(mask, "abstract")
            ? absentTextField(reason)
            : presentTextField(presentText.abstract),
          headnote: isAbsent(mask, "headnote")
            ? absentTextField(reason)
            : presentTextField(presentText.headnote),
          legalSentence: isAbsent(mask, "legalSentence")
            ? absentTextField(reason)
            : presentTextField(presentText.legalSentence),
          summary: isAbsent(mask, "summary")
            ? absentTextField(reason)
            : presentTextField(presentText.summary),
        };
        const expectedAbsent = DECISION_TEXT_FIELD_KEYS.filter((field) =>
          isAbsent(mask, field),
        ).map((field) => ({ field, reason }));
        const expectedPresent = Object.fromEntries(
          DECISION_TEXT_FIELD_KEYS.filter(
            (field) => !isAbsent(mask, field),
          ).map((field) => [field, presentText[field]]),
        );
        const stored = storeDecisionTextFields({
          metadata: { sourceReference: "fixture-reference" },
          textFields,
        });
        const expectedStored = {
          sourceReference: "fixture-reference",
          [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
            DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
          ...expectedPresent,
          ...(expectedAbsent.length === 0
            ? {}
            : { [DECISION_TEXT_ABSENCE_METADATA_KEY]: expectedAbsent }),
        };
        const split = splitStoredDecisionTextMetadata(stored);

        expect(stored).toEqual(expectedStored);
        expect(split).toEqual({
          metadata: { sourceReference: "fixture-reference" },
          textFields,
        });
        expect(
          storeDecisionTextFields({
            metadata: split.metadata,
            textFields: split.textFields,
          }),
        ).toEqual(stored);
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
      [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
        DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        { field: "headnote", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "legalSentence", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "summary", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
      ],
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
      [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
        DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        {
          field: "abstract",
          reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
        },
        { field: "headnote", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "legalSentence", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "summary", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
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

  test("legacy nullable fields without a sidecar entry still read as not published", () => {
    for (const field of DECISION_TEXT_FIELD_KEYS) {
      for (const value of [null, undefined]) {
        for (const sidecar of [undefined, []]) {
          const metadata = {
            [field]: value,
            ...(sidecar === undefined
              ? {}
              : {
                  [DECISION_TEXT_ABSENCE_METADATA_KEY]: sidecar,
                }),
          };
          expect(readDecisionTextMetadata(metadata).textFields).toEqual(
            absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
          );
        }
      }
    }
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
      [
        {
          field: "abstract",
          reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
          unexpected: true,
        },
      ],
      [{ field: "unknown", reason: "unknown_reason" }],
      [{ field: "abstract", reason: "unknown_reason" }],
      [{ field: "abstract", reason: 42 }],
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
      { field: "unknown", reason: "unknown_reason" },
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
      [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
        DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        { field: "abstract", reason: TEXT_ABSENCE_REASON.PARSE_FAILED },
        { field: "headnote", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "legalSentence", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "summary", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
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
      [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
        DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        { field: "headnote", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "legalSentence", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
        { field: "summary", reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED },
      ],
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
    expect(readDecisionHeadnote({ headnote: "  ", keywords: null })).toEqual({
      type: "absent",
      reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
    });
  });

  test("a decision with no sentence shows what it was filed under", () => {
    expect(
      readDecisionHeadnote({
        headnote: null,
        keywords: ["  Nájem ", "", "Výpověď", "Nájem"],
      }),
    ).toEqual({
      type: "keywords",
      items: ["Nájem", "Výpověď"],
      omitted: 0,
    });
  });

  test("a sentence wins over the terms beside it", () => {
    expect(
      readDecisionHeadnote({
        headnote: "Právní věta.",
        keywords: ["Nájem"],
      }),
    ).toEqual({ type: "present", text: "Právní věta.", truncated: false });
  });
});
