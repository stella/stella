import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import type {
  Block,
  Inline,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";
import { hasUsableAst, plainTextOf } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import type { CollectionDocumentPart } from "@/api/lib/legal-search/collection-document-part";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-content-hash";

import {
  composeCollectionDocument,
  planCollectionDocument,
} from "./compose-collection-document";
import type {
  CollectionPublication,
  LoadedCollectionPublication,
} from "./compose-collection-document";

const identity = {
  caseNumber: "Ra 2025/01/0001",
  court: "Verwaltungsgerichtshof",
  ecli: null,
  decisionDate: "2025-01-02",
  decisionType: "decision",
};

const paragraph = (text: string, id: string) =>
  ({
    type: "paragraph",
    id,
    anchorId: id,
    plainText: text,
    inlines: [{ type: "text", text }],
  }) satisfies Block;

const publication = (
  sourceDocumentId: string,
  documentPart: CollectionDocumentPart,
) =>
  ({
    source: {
      id: "018f39de-0001-7000-8000-000000000001",
      adapterKey: "at-vwgh",
      name: "Austrian collection fixture",
      allowsDerivedAi: true,
    },
    sourceDocumentId,
    sourceUrl: `https://example.test/collection/${sourceDocumentId}`,
    retrievedAt: "2026-01-01T12:00:00.000Z",
    documentPart,
  }) satisfies CollectionPublication;

const body = (texts: readonly string[], postId: string) => {
  // Publisher-local identities repeat in separate retained posts.
  const blocks = texts.map((text, index) => paragraph(text, `block-${index}`));
  return {
    text: texts.join("\n\n"),
    sections: [],
    ast: {
      version: 1,
      source: {
        system: "at-vwgh",
        documentId: postId,
        webUrl: `https://example.test/collection/${postId}`,
        printUrl: "",
      },
      metadata: { ...identity, keywords: [], statutes: ["Actual statute"] },
      blocks,
    },
  } satisfies CorpusPayload;
};

const section = (
  sectionNumber: number,
  text = `Section ${sectionNumber}`,
  postId = `post-${sectionNumber}`,
) =>
  ({
    publication: publication(postId, {
      extent: "section",
      sectionNumber,
      firstBlock: 1,
      afterLastBlock: 2,
      collectionLabel: "Printed collection label",
      legalSentence: `Actual headnote ${sectionNumber}`,
      keywords: [`Keyword ${sectionNumber}`],
    }),
    payload: body(["Common opening", text, "Common closing"], postId),
  }) satisfies LoadedCollectionPublication;

const compose = (publications: readonly LoadedCollectionPublication[]) =>
  composeCollectionDocument({
    decisionId: "fixture-decision",
    identity,
    publications,
  });

const withOpening = (
  part: ReturnType<typeof section>,
  inlines: Inline[],
  role?: ParagraphRole,
) => ({
  publication: part.publication,
  payload: {
    ...part.payload,
    ast: {
      ...part.payload.ast,
      blocks: part.payload.ast.blocks.map((block, index) =>
        index === 0
          ? { ...block, role, inlines, plainText: plainTextOf(inlines) }
          : block,
      ),
    },
  },
});

const listOpening = [
  { type: "text", text: "1. A long item" },
  { type: "line-break" },
  { type: "text", text: "2. Next item" },
] satisfies Inline[];

test("list wrapping retains an original layout and attributes both variants", () => {
  const first = withOpening(section(1), listOpening);
  const second = withOpening(section(2), [
    { type: "text", text: "1. A" },
    { type: "line-break" },
    { type: "text", text: "long item" },
    { type: "line-break" },
    { type: "text", text: "2. Next item" },
  ]);
  const result = compose([second, first]).unwrap(
    "Expected wrapping variants to compose",
  );
  expect(result.payload.ast?.blocks.at(0)?.plainText).toBe(
    plainTextOf(listOpening),
  );
  expect(
    result.contextLayouts.map(({ representation }) => representation),
  ).toEqual(["displayed", "alternate-wrapping"]);
  expect(new Set(result.contextLayouts.map(({ sha256 }) => sha256)).size).toBe(
    2,
  );
  expect(second.payload.ast.blocks.at(0)?.plainText).toBe(
    "1. A\nlong item\n2. Next item",
  );
});

test("case-law.collection-list-wrapping-preserves-original", () => {
  assertProperty(
    "case-law.collection-list-wrapping-preserves-original",
    fc.property(
      fc.array(fc.constantFrom("Alpha", "Beta", "Gamma"), {
        minLength: 2,
        maxLength: 8,
      }),
      fc.nat(),
      (words, offset) => {
        const split = 1 + (offset % (words.length - 1));
        const original = [
          { type: "text", text: `1. ${words.join(" ")}` },
          { type: "line-break" },
          { type: "text", text: "2. End" },
        ] satisfies Inline[];
        const wrapped = [
          { type: "text", text: `1. ${words.slice(0, split).join(" ")}` },
          { type: "line-break" },
          { type: "text", text: words.slice(split).join(" ") },
          { type: "line-break" },
          { type: "text", text: "2. End" },
        ] satisfies Inline[];
        const result = compose([
          withOpening(section(2), wrapped),
          withOpening(section(1), original),
        ]).unwrap(
          "Expected list wrapping to retain its original representation",
        );
        expect(result.payload.ast?.blocks.at(0)?.plainText).toBe(
          plainTextOf(original),
        );
        expect(
          result.contextLayouts.map(({ representation }) => representation),
        ).toEqual(["displayed", "alternate-wrapping"]);
      },
    ),
  );
});

test.each([
  {
    original: [
      { type: "text", text: "First" },
      { type: "line-break" },
      { type: "text", text: "Next" },
    ] satisfies Inline[],
    variant: [{ type: "text", text: "First Next" }] satisfies Inline[],
  },
  {
    original: listOpening,
    variant: [
      { type: "bold", children: [{ type: "text", text: "1. A long item" }] },
      { type: "line-break" },
      { type: "text", text: "2. Next item" },
    ] satisfies Inline[],
  },
  {
    original: [
      {
        type: "link",
        href: "https://example.test/first",
        children: [{ type: "text", text: "1. A long item" }],
      },
    ] satisfies Inline[],
    variant: [
      {
        type: "link",
        href: "https://example.test/second",
        children: [{ type: "text", text: "1. A long item" }],
      },
    ] satisfies Inline[],
  },
])(
  "structural context differences remain conflicts %#",
  ({ original, variant }) => {
    const result = compose([
      withOpening(section(1), original),
      withOpening(section(2), variant),
    ]);
    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return panic("Expected a structural context conflict");
    }
    expect(result.error.reason).toBe("common-context-conflict");
    return undefined;
  },
);

test("quoted context and competing same-ordinal sections retain exact layout", () => {
  const wrapped = [
    { type: "text", text: "1. A" },
    { type: "line-break" },
    { type: "text", text: "long item" },
    { type: "line-break" },
    { type: "text", text: "2. Next item" },
  ] satisfies Inline[];
  expect(
    Result.isError(
      compose([
        withOpening(section(1), listOpening, "quote"),
        withOpening(section(2), wrapped, "quote"),
      ]),
    ),
  ).toBe(true);
  const result = compose([
    section(1, "1. A long item", "first"),
    section(1, "1. A\nlong item", "second"),
  ]);
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    return panic("Expected an exact section conflict");
  }
  expect(result.error.reason).toBe("section-conflict");
  return undefined;
});

test("printed list depth remains a structural context boundary", () => {
  const second = withOpening(section(2), listOpening);
  const result = compose([
    withOpening(section(1), listOpening),
    {
      publication: second.publication,
      payload: {
        ...second.payload,
        ast: {
          ...second.payload.ast,
          blocks: second.payload.ast.blocks.map((block, index) =>
            index === 0 ? { ...block, listDepth: 1 as const } : block,
          ),
        },
      },
    },
  ]);
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    return panic("Expected list depth to remain structural");
  }
  expect(result.error.reason).toBe("common-context-conflict");
  return undefined;
});

test("Austrian collection sections retain common context once in printed order", () => {
  const parts = [section(1), section(2), section(3)];
  const result = compose(parts.toReversed());
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw result.error;
  }
  expect(result.value.plan.extent).toBe("section");
  expect(result.value.payload.text).toBe(
    "Common opening\n\nSection 1\n\nSection 2\n\nSection 3\n\nCommon closing",
  );
  expect(
    result.value.plan.publications.map(
      ({ sourceDocumentId }) => sourceDocumentId,
    ),
  ).toEqual(["post-1", "post-2", "post-3"]);
  const ast = result.value.payload.ast;
  if (!hasUsableAst(ast)) {
    panic("Expected composed decision AST");
  }
  expect(ast.blocks).toHaveLength(5);
  expect(new Set(ast.blocks.map(({ id }) => id)).size).toBe(5);
  expect(
    result.value.payload.sections?.map(({ text }) => text).join("\n"),
  ).toContain("Section 2");
  expect(
    parts.map(
      ({ publication: original }) => original.documentPart.legalSentence,
    ),
  ).toEqual(["Actual headnote 1", "Actual headnote 2", "Actual headnote 3"]);
  if (ast.metadata.type === "guidance") {
    panic("Expected composed decision metadata");
  }
  expect(ast.metadata.keywords).toEqual([
    "Keyword 1",
    "Keyword 2",
    "Keyword 3",
  ]);
});

test("an explicit complete edition wins without composing partial context", () => {
  const complete = {
    publication: publication("4912", {
      extent: "complete",
      legalSentence: null,
      keywords: [],
    }),
    payload: body(["Full official edition", "All retained sections"], "4912"),
  } satisfies LoadedCollectionPublication;
  const conflictingPart = section(1);
  const result = compose([
    conflictingPart,
    complete,
    section(2, "Different part"),
  ]);
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw result.error;
  }
  expect(result.value.plan.extent).toBe("complete");
  expect(
    result.value.plan.publications.map(
      ({ sourceDocumentId }) => sourceDocumentId,
    ),
  ).toEqual(["4912"]);
  expect(result.value.payload).toBe(complete.payload);
});

test("identical duplicate numbered sections keep every post but repeat no text", () => {
  const result = compose([section(1), section(1, "Section 1", "another-post")]);
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw result.error;
  }
  expect(result.value.plan.publications).toHaveLength(2);
  expect(result.value.payload.text).toBe(
    "Common opening\n\nSection 1\n\nCommon closing",
  );
});

test("different text for one printed section is a conflict", () => {
  const result = compose([
    section(1),
    section(1, "Conflicting text", "another-post"),
  ]);
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    panic("Expected section conflict");
  }
  expect(result.error.reason).toBe("section-conflict");
});

test("different common context is a conflict", () => {
  const other = section(2);
  const result = compose([
    section(1),
    {
      publication: other.publication,
      payload: body(
        ["Different opening", "Section 2", "Common closing"],
        "post-2",
      ),
    },
  ]);
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    panic("Expected common-context conflict");
  }
  expect(result.error.reason).toBe("common-context-conflict");
});

test("different collection sources and labels are not stitched together", () => {
  const first = section(1);
  const second = section(2);
  const anotherSource = {
    ...second.publication,
    source: {
      ...second.publication.source,
      id: "018f39de-0001-7000-8000-000000000002",
    },
  };
  const plan = planCollectionDocument([first.publication, anotherSource]);
  expect(
    plan?.publications.map(({ sourceDocumentId }) => sourceDocumentId),
  ).toEqual(["post-1"]);
  const anotherLabel = publication("post-2", {
    extent: "section",
    sectionNumber: 2,
    firstBlock: 1,
    afterLastBlock: 2,
    collectionLabel: "Another edition",
    legalSentence: null,
    keywords: [],
  });
  expect(
    planCollectionDocument([first.publication, anotherLabel])?.publications.map(
      ({ sourceDocumentId }) => sourceDocumentId,
    ),
  ).toEqual(["post-1"]);
});

test("a single section remains partial and unclassified content stays unclassified", () => {
  expect(planCollectionDocument([section(1).publication])?.extent).toBe(
    "section",
  );
  expect(
    planCollectionDocument([
      publication("whole-looking", {
        extent: "unclassified",
        legalSentence: null,
        keywords: [],
      }),
    ])?.extent,
  ).toBe("unclassified");
});

test("out-of-range retained offsets fail instead of reading empty text", () => {
  const loaded = section(1);
  const invalid = publication("post-1", {
    extent: "section",
    sectionNumber: 1,
    firstBlock: 1,
    afterLastBlock: 20,
    collectionLabel: "Printed label",
    legalSentence: null,
    keywords: [],
  });
  const result = compose([{ publication: invalid, payload: loaded.payload }]);
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    panic("Expected invalid section");
  }
  expect(result.error.reason).toBe("invalid-section");
});

test("duplicate publication identities are refused before payload selection", () => {
  const loaded = section(1);
  const result = compose([loaded, loaded]);
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    panic("Expected duplicate publication");
  }
  expect(result.error.reason).toBe("duplicate-publication");
});

test("case-law.collection-section-order-and-duplicate-invariance", () => {
  assertProperty(
    "case-law.collection-section-order-and-duplicate-invariance",
    fc.property(
      fc.uniqueArray(fc.integer({ min: 1, max: 100 }), {
        minLength: 1,
        maxLength: 12,
      }),
      (ordinals) => {
        const publications = ordinals.flatMap((ordinal) => [
          section(ordinal),
          section(ordinal, `Section ${ordinal}`, `duplicate-${ordinal}`),
        ]);
        const result = compose(publications);
        if (Result.isError(result)) {
          return panic("Expected coherent generated sections");
        }
        const ordered = ordinals.toSorted((left, right) => left - right);
        expect(result.value.payload.text).toBe(
          [
            "Common opening",
            ...ordered.map((ordinal) => `Section ${ordinal}`),
            "Common closing",
          ].join("\n\n"),
        );
        expect(result.value.plan.publications).toHaveLength(
          publications.length,
        );
        const ast = result.value.payload.ast;
        if (!hasUsableAst(ast)) {
          return panic("Expected canonical generated AST");
        }
        expect(new Set(ast.blocks.map(({ id }) => id)).size).toBe(
          ordered.length + 2,
        );
        return undefined;
      },
    ),
  );
});
