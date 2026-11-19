import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import type { Block } from "@stll/legal-ast/document-ast";
import { hasUsableAst } from "@stll/legal-ast/document-ast";
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
