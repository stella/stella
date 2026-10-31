import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import { softLawContentHash, softLawIdentityKey } from "./soft-law-fingerprint";
import { SoftLawItemError } from "./soft-law-types";
import type { SoftLawDocumentInput, SoftLawMetadata } from "./soft-law-types";

const evidence = {
  url: "https://www.edpb.europa.eu/guidelines/example",
  quote: "Adopted version",
  locator: "heading",
};
const metadata = {
  title: "Guidelines on processing",
  kind: "guideline",
  sourceKind: "Guidelines",
  statedReference: { state: "stated", value: "01/2024" },
  issuedOn: { state: "stated", value: "2024-01-16" },
  expression: {
    type: "identified",
    language: "en",
    revision: { state: "stated", value: "1.0" },
  },
  stage: { state: "adopted", evidence },
  relations: [],
  validity: { state: "not_stated", basis: "source_stated" },
} as const satisfies SoftLawMetadata;
const document = (value: SoftLawMetadata): SoftLawDocumentInput => ({
  metadata: value,
  raw: [
    {
      role: "document",
      purpose: "document",
      bytes: new TextEncoder().encode("body"),
      contentType: "text/html",
    },
  ],
  text: "body",
  extractionQuality: "html",
  sourceDates: {},
});

const referenceArbitrary = fc
  .tuple(
    fc.constantFrom("é", "Å", "ö", "č", "ñ"),
    fc.integer({ min: 1, max: 9999 }),
  )
  .map(([letter, number]) => `${letter} ${number}/2024`);

test("EU expression identity preserves Unicode equivalence and ignores translated titles", async () =>
  assertProperty(
    "EU expression identity preserves Unicode equivalence and ignores translated titles",
    fc.property(referenceArbitrary, fc.string(), (reference, title) => {
      expect(normalizeUnicode(reference, "NFC")).not.toBe(
        normalizeUnicode(reference, "NFD"),
      );
      const original = {
        ...metadata,
        statedReference: {
          state: "stated",
          value: normalizeUnicode(reference, "NFC"),
        },
      } as const;
      const equivalent = {
        ...original,
        title: `Translated ${title}`,
        statedReference: {
          state: "stated",
          value: `  ${normalizeUnicode(reference, "NFD")}  `,
        },
      } as const;
      expect(softLawIdentityKey("eu-edpb", equivalent).unwrap()).toBe(
        softLawIdentityKey("eu-edpb", original).unwrap(),
      );
    }),
  ));

test("EU expression languages and source revisions never share an identity", async () =>
  assertProperty(
    "EU expression languages and source revisions never share an identity",
    fc.property(
      fc.uniqueArray(fc.constantFrom("en", "cs", "de", "fr", "es", "pl"), {
        minLength: 2,
        maxLength: 2,
      }),
      fc.uniqueArray(fc.integer({ min: 1, max: 999 }), {
        minLength: 2,
        maxLength: 2,
      }),
      (languages, revisions) => {
        const identities = languages.flatMap((language) =>
          revisions.map((revision) =>
            softLawIdentityKey("eu-edpb", {
              ...metadata,
              expression: {
                type: "identified",
                language,
                revision: { state: "stated", value: String(revision) },
              },
            }).unwrap(),
          ),
        );
        expect(new Set(identities).size).toBe(4);
      },
    ),
  ));

test("EU authority and document kind participate in expression identity", () => {
  const numbered = {
    ...metadata,
    statedReference: { state: "stated", value: "WP 240" },
  } as const;
  const original = softLawIdentityKey("eu-edpb", numbered).unwrap();
  expect(softLawIdentityKey("eu-wp29", numbered).unwrap()).not.toBe(original);
  expect(
    softLawIdentityKey("eu-edpb", { ...numbered, kind: "opinion" }).unwrap(),
  ).not.toBe(original);
});

test("EDPB opinion series participate in numbered identity", () => {
  const opinion = { ...metadata, kind: "opinion" } as const;
  expect(
    softLawIdentityKey("eu-edpb", {
      ...opinion,
      sourceKind: "Legislative opinion",
    }).unwrap(),
  ).not.toBe(
    softLawIdentityKey("eu-edpb", {
      ...opinion,
      sourceKind: "Opinion of the Board (Art. 64)",
    }).unwrap(),
  );
});

test("WP29 titles do not participate in numbered identity", () => {
  const wp29 = {
    ...metadata,
    statedReference: { state: "stated", value: "WP 240" },
  } as const;
  expect(
    softLawIdentityKey("eu-wp29", {
      ...wp29,
      sourceKind: "Original title",
    }).unwrap(),
  ).toBe(
    softLawIdentityKey("eu-wp29", {
      ...wp29,
      sourceKind: "Corrected title",
    }).unwrap(),
  );
});

test("a lifecycle transition revises content without changing expression identity", () => {
  const consultation = {
    ...metadata,
    stage: { state: "consultation", evidence },
  } as const;
  expect(softLawIdentityKey("eu-edpb", consultation).unwrap()).toBe(
    softLawIdentityKey("eu-edpb", metadata).unwrap(),
  );
  expect(softLawContentHash(document(consultation))).not.toBe(
    softLawContentHash(document(metadata)),
  );
  const superseded = {
    ...metadata,
    validity: { state: "superseded", basis: "source_stated" },
    relations: [{ type: "superseded_by", reference: "02/2024", evidence }],
  } as const;
  expect(softLawIdentityKey("eu-edpb", superseded).unwrap()).toBe(
    softLawIdentityKey("eu-edpb", metadata).unwrap(),
  );
  expect(softLawContentHash(document(superseded))).not.toBe(
    softLawContentHash(document(metadata)),
  );
});

test("source relation ordering does not churn a stored expression", async () =>
  assertProperty(
    "source relation ordering does not churn a stored expression",
    fc.property(
      fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 8 }),
      (references) => {
        const relations = references.map(
          (reference) => ({ type: "endorses", reference, evidence }) as const,
        );
        const original = document({ ...metadata, relations });
        expect(
          softLawContentHash(
            document({ ...metadata, relations: relations.toReversed() }),
          ),
        ).toBe(softLawContentHash(original));
        expect(
          softLawContentHash(
            document({ ...metadata, relations: relations.slice(1) }),
          ),
        ).not.toBe(softLawContentHash(original));
      },
    ),
  ));

test("EU metadata must identify a source expression and use an admitted document kind", () => {
  const {
    expression: _expression,
    stage: _stage,
    relations: _relations,
    ...historical
  } = metadata;
  const invalid = [
    historical,
    { ...historical, stage: metadata.stage, relations: metadata.relations },
    {
      ...historical,
      expression: metadata.expression,
      relations: metadata.relations,
    },
    { ...historical, expression: metadata.expression, stage: metadata.stage },
    { ...metadata, expression: { type: "unspecified" } },
    {
      ...metadata,
      expression: {
        type: "identified",
        language: "",
        revision: { state: "not_stated" },
      },
    },
    {
      ...metadata,
      expression: {
        type: "identified",
        language: "not a language",
        revision: { state: "not_stated" },
      },
    },
    {
      ...metadata,
      expression: {
        type: "identified",
        language: "en",
        revision: { state: "stated", value: " " },
      },
    },
    { ...metadata, statedReference: { state: "not_stated" } },
    { ...metadata, kind: "inspection_report" },
    { ...metadata, sourceKind: " " },
  ] as const satisfies readonly SoftLawMetadata[];
  for (const value of invalid) {
    const result = softLawIdentityKey("eu-edpb", value);
    if (!Result.isError(result)) {
      panic("Invalid EU expression was accepted");
    }
    expect(result.error).toBeInstanceOf(SoftLawItemError);
    expect(result.error.tag).toBe("invalid_document");
  }
});

test("WP29 positions remain authority-specific and CZ historical metadata remains admissible", () => {
  const position = {
    ...metadata,
    kind: "position",
    statedReference: { state: "stated", value: "WP 240" },
  } as const;
  const rejected = softLawIdentityKey("eu-edpb", position);
  if (!Result.isError(rejected)) {
    panic("EDPB position was admitted");
  }
  expect(rejected.error.tag).toBe("invalid_document");
  expect(Result.isOk(softLawIdentityKey("eu-wp29", position))).toBe(true);
  const {
    expression: _expression,
    stage: _stage,
    relations: _relations,
    ...historical
  } = metadata;
  expect(Result.isOk(softLawIdentityKey("cz-uoou", historical))).toBe(true);
});

test("EU metadata cannot omit the publisher's document kind", () => {
  const { sourceKind: _sourceKind, ...withoutSourceKind } = metadata;
  const result = softLawIdentityKey("eu-edpb", withoutSourceKind);
  if (!Result.isError(result)) {
    panic("EU source kind was omitted");
  }
  expect(result.error).toBeInstanceOf(SoftLawItemError);
  expect(result.error.tag).toBe("invalid_document");
});

test("discovery refreshes preserve document versions while document byte changes revise them", async () =>
  assertProperty(
    "discovery refreshes preserve document versions while document byte changes revise them",
    fc.property(fc.uint8Array({ minLength: 1, maxLength: 100 }), (bytes) => {
      const discovery = {
        role: "index",
        purpose: "discovery",
        bytes,
        contentType: "text/html",
      } as const;
      const original = {
        ...document(metadata),
        raw: [...document(metadata).raw, discovery],
      };
      const refreshedDiscovery = {
        ...discovery,
        bytes: new Uint8Array([...bytes, 0]),
      };
      expect(refreshedDiscovery.bytes).not.toEqual(discovery.bytes);
      const discoveryRefresh = {
        ...original,
        raw: [...document(metadata).raw, refreshedDiscovery],
      };
      expect(softLawContentHash(discoveryRefresh)).toBe(
        softLawContentHash(original),
      );
      expect(
        softLawContentHash({ ...original, raw: original.raw.toReversed() }),
      ).toBe(softLawContentHash(original));
      const revisedDocument = {
        ...original,
        raw: original.raw.map((part) =>
          part.purpose === "document"
            ? { ...part, bytes: new Uint8Array([...part.bytes, 0]) }
            : part,
        ),
      };
      expect(softLawContentHash(revisedDocument)).not.toBe(
        softLawContentHash(original),
      );
    }),
  ));

test("WP29 reference and revision typography share identity while letter suffixes remain distinct", async () =>
  assertProperty(
    "WP29 reference and revision typography share identity while letter suffixes remain distinct",
    fc.property(fc.integer({ min: 1, max: 999 }), (number) => {
      const source = {
        ...metadata,
        statedReference: { state: "stated", value: `WP ${number} rev.01` },
        expression: {
          type: "identified",
          language: "en",
          revision: { state: "stated", value: "rev.01" },
        },
      } as const;
      const compact = {
        ...source,
        statedReference: { state: "stated", value: `wp${number}rev01` },
        expression: {
          type: "identified",
          language: "en",
          revision: { state: "stated", value: "rev01" },
        },
      } as const;
      expect(softLawIdentityKey("eu-wp29", source).unwrap()).toBe(
        softLawIdentityKey("eu-wp29", compact).unwrap(),
      );
      const plain = {
        ...metadata,
        statedReference: { state: "stated", value: `WP ${number}` },
      } as const;
      expect(softLawIdentityKey("eu-wp29", plain).unwrap()).toBe(
        softLawIdentityKey("eu-wp29", {
          ...plain,
          statedReference: { state: "stated", value: `wp${number}` },
        }).unwrap(),
      );
      expect(
        softLawIdentityKey("eu-wp29", {
          ...plain,
          statedReference: { state: "stated", value: `WP${number}a` },
        }).unwrap(),
      ).not.toBe(softLawIdentityKey("eu-wp29", plain).unwrap());
      expect(source.statedReference.value).toBe(`WP ${number} rev.01`);
      expect(source.expression.revision.value).toBe("rev.01");
    }),
  ));

test("unnumbered EDPB publisher identities survive title and date changes", () => {
  const statement = {
    ...metadata,
    kind: "statement",
    sourceKind: "Statement",
    statedReference: { state: "not_stated" },
    sourceDocumentId: "documents/215",
  } as const;
  const original = softLawIdentityKey("eu-edpb", statement).unwrap();
  expect(
    softLawIdentityKey("eu-edpb", {
      ...statement,
      title: "Revised publisher title",
      issuedOn: { state: "stated", value: "2024-02-16" },
    }).unwrap(),
  ).toBe(original);
  expect(
    softLawIdentityKey("eu-edpb", {
      ...statement,
      sourceDocumentId: "documents/216",
    }).unwrap(),
  ).not.toBe(original);
});

test("nested metadata key order preserves the persisted retry fingerprint", () => {
  const reorderedExpression = {
    revision: {
      value: metadata.expression.revision.value,
      state: metadata.expression.revision.state,
    },
    language: metadata.expression.language,
    type: metadata.expression.type,
  } as const;
  const reorderedStage = {
    evidence: {
      locator: evidence.locator,
      quote: evidence.quote,
      url: evidence.url,
    },
    state: metadata.stage.state,
  } as const;
  for (const reordered of [
    { ...metadata, expression: reorderedExpression },
    { ...metadata, stage: reorderedStage },
    { ...metadata, expression: reorderedExpression, stage: reorderedStage },
  ]) {
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(metadata));
    expect(softLawContentHash(document(reordered))).toBe(
      softLawContentHash(document(metadata)),
    );
  }
});
