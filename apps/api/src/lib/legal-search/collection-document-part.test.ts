import { Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import {
  COLLECTION_DOCUMENT_EXTENT,
  collectionDocumentPartSchema,
  decodeCollectionDocumentBody,
  encodeCollectionDocumentBody,
  validateCollectionDocumentPart,
} from "./collection-document-part";
import type { CollectionDocumentPart } from "./collection-document-part";
import type { CorpusPayload } from "./corpus-content-hash";

const ast = {
  version: 1,
  source: {
    system: "canadian-reporter",
    documentId: "part-2",
    webUrl: "https://example.test/part-2",
    printUrl: "https://example.test/part-2",
  },
  metadata: {
    caseNumber: "2024 SCC 3",
    ecli: null,
    court: "Supreme Court of Canada",
    decisionDate: "2024-01-01",
    decisionType: "Judgment",
    keywords: [],
    statutes: [],
  },
  blocks: [
    "Common report prefix",
    "Second numbered section",
    "Common report suffix",
  ].map(
    (text, index) =>
      ({
        type: "paragraph",
        id: `paragraph-${index}`,
        anchorId: `anchor-${index}`,
        number: index + 1,
        plainText: text,
        inlines: [{ type: "text", text }],
      }) satisfies Block,
  ),
} satisfies DocumentAst;
const payload = {
  text: "Common report prefix\nSecond numbered section\nCommon report suffix",
  sections: null,
  ast,
} satisfies CorpusPayload;
const section = {
  extent: COLLECTION_DOCUMENT_EXTENT.SECTION,
  sectionNumber: 2,
  firstBlock: 1,
  afterLastBlock: 2,
  collectionLabel: "No. 12",
  legalSentence: null,
  keywords: ["Appeals"],
} as const satisfies CollectionDocumentPart;

test("a non-Czech collection retains its whole AST while selecting only its printed section", () => {
  expect(v.safeParse(collectionDocumentPartSchema, section).success).toBe(true);
  expect(validateCollectionDocumentPart(section, payload).unwrap()).toEqual(
    section,
  );
  const encoded = encodeCollectionDocumentBody(payload).unwrap();
  expect(decodeCollectionDocumentBody(encoded).unwrap()).toEqual(payload);
  expect(decodeCollectionDocumentBody(encoded).unwrap().ast).toEqual(ast);
  expect(section.legalSentence).toBeNull();
});

test("equivalent corpus objects have identical immutable bytes", () => {
  expect(encodeCollectionDocumentBody(payload).unwrap()).toEqual(
    encodeCollectionDocumentBody({
      ast,
      sections: null,
      text: payload.text,
    }).unwrap(),
  );
});

test.each([
  { firstBlock: 1, afterLastBlock: 1 },
  { firstBlock: 2, afterLastBlock: 1 },
  { firstBlock: 0, afterLastBlock: 4 },
])("section offsets must name a nonempty half-open range: %j", (range) => {
  expect(
    Result.isError(
      validateCollectionDocumentPart({ ...section, ...range }, payload),
    ),
  ).toBe(true);
});

test("unclassified and complete are distinct even for a retained empty payload", () => {
  const empty = { text: null, sections: null, ast: null };
  expect(
    Result.isError(
      validateCollectionDocumentPart(
        {
          extent: COLLECTION_DOCUMENT_EXTENT.COMPLETE,
          legalSentence: null,
          keywords: [],
        },
        empty,
      ),
    ),
  ).toBe(true);
  expect(
    Result.isOk(
      validateCollectionDocumentPart(
        {
          extent: COLLECTION_DOCUMENT_EXTENT.UNCLASSIFIED,
          legalSentence: null,
          keywords: [],
        },
        empty,
      ),
    ),
  ).toBe(true);
});

test("an unreadable body snapshot returns a typed failure, never an empty body", () => {
  for (const body of ["", "null", "{}", "not JSON"]) {
    expect(
      Result.isError(
        decodeCollectionDocumentBody(new TextEncoder().encode(body)),
      ),
    ).toBe(true);
  }
});

test("source-specific part descriptors still satisfy canonical metadata bounds", () => {
  for (const descriptor of [
    { ...section, collectionLabel: "a".repeat(257) },
    { ...section, keywords: Array.from({ length: 129 }, () => "Subject") },
  ]) {
    expect(
      Result.isError(validateCollectionDocumentPart(descriptor, payload)),
    ).toBe(true);
  }
});
