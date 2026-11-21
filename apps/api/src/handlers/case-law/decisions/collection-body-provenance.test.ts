import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  COLLECTION_PUBLICATION_CONTRIBUTION,
  COLLECTION_PUBLICATION_PROJECTION_MAX,
  decisionBodyAllowsDerivedAi,
  decisionBodySourceSchema,
} from "@stll/api-contract/case-law-body-source";

import type { CollectionDocumentPart } from "@/api/lib/legal-search/collection-document-part";

import {
  collectionBodySourceOf,
  publicationProvenanceOf,
} from "./collection-body-provenance";
import type { CollectionPublication } from "./compose-collection-document";

const documentPart = {
  extent: "section",
  sectionNumber: 1,
  firstBlock: 0,
  afterLastBlock: 1,
  collectionLabel: "Printed label",
  legalSentence: "Retained headnote",
  keywords: ["Retained keyword"],
} satisfies CollectionDocumentPart;

const publication = (sourceDocumentId: string, allowsDerivedAi = true) =>
  ({
    source: {
      id: "018f39de-0001-7000-8000-000000000001",
      name: "Collection fixture",
      adapterKey: "at-vwgh",
      allowsDerivedAi,
    },
    sourceDocumentId,
    sourceUrl: `https://example.test/collection/${sourceDocumentId}`,
    retrievedAt: "2026-01-01T12:00:00.000Z",
    documentPart,
  }) satisfies CollectionPublication;

test("bounded provenance states its omitted records and exact retained total", () => {
  const primary = publicationProvenanceOf(
    publication("primary"),
    COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
  );
  const related = Array.from({ length: 40 }, (_, index) =>
    publicationProvenanceOf(
      publication(`related-${index}`),
      COLLECTION_PUBLICATION_CONTRIBUTION.RELATED,
    ),
  );
  const result = collectionBodySourceOf({
    primary,
    publications: related,
    totalCount: 41,
  });
  expect(v.safeParse(decisionBodySourceSchema, result).success).toBe(true);
  expect(result.extent).toBe("section");
  expect(result.provenance).toMatchObject({
    coverage: "truncated",
    totalCount: 41,
    omittedCount: 41 - COLLECTION_PUBLICATION_PROJECTION_MAX,
  });
  expect(result.provenance.records).toHaveLength(
    COLLECTION_PUBLICATION_PROJECTION_MAX,
  );
  expect(result.provenance.records.at(0)?.sourceDocumentId).toBe("primary");
  expect(JSON.stringify(result)).not.toContain("Retained headnote");
  expect(JSON.stringify(result)).not.toContain("Retained keyword");
});

test("served records stay visible even when related records filled the projection first", () => {
  const primary = publicationProvenanceOf(
    publication("primary"),
    COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
  );
  const otherBody = publicationProvenanceOf(
    publication("other-body", false),
    COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
  );
  const related = Array.from({ length: 40 }, (_, index) =>
    publicationProvenanceOf(
      publication(`related-${index}`),
      COLLECTION_PUBLICATION_CONTRIBUTION.RELATED,
    ),
  );
  const result = collectionBodySourceOf({
    primary,
    publications: [...related, otherBody],
    totalCount: 42,
  });
  expect(
    result.provenance.records.map(({ sourceDocumentId }) => sourceDocumentId),
  ).toContain("other-body");
  expect(
    decisionBodyAllowsDerivedAi({
      source: { allowsDerivedAi: true },
      bodySource: result,
    }),
  ).toBe(false);
});

test("related source restrictions do not change the permissions of text they did not supply", () => {
  const primary = publicationProvenanceOf(
    publication("primary"),
    COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
  );
  const related = publicationProvenanceOf(
    publication("related", false),
    COLLECTION_PUBLICATION_CONTRIBUTION.RELATED,
  );
  const result = collectionBodySourceOf({
    primary,
    publications: [related],
    totalCount: 2,
  });
  expect(
    decisionBodyAllowsDerivedAi({
      source: { allowsDerivedAi: true },
      bodySource: result,
    }),
  ).toBe(true);
  expect(
    decisionBodyAllowsDerivedAi({
      source: { allowsDerivedAi: false },
      bodySource: result,
    }),
  ).toBe(false);
  expect(result.provenance).toMatchObject({
    coverage: "all",
    totalCount: 2,
    omittedCount: 0,
  });
});

test("a duplicate related projection cannot demote serving evidence", () => {
  const primary = publicationProvenanceOf(
    publication("primary"),
    COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
  );
  const body = publicationProvenanceOf(
    publication("body", false),
    COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
  );
  const related = publicationProvenanceOf(
    publication("body", false),
    COLLECTION_PUBLICATION_CONTRIBUTION.RELATED,
  );
  const result = collectionBodySourceOf({
    primary,
    publications: [body, related],
    totalCount: 2,
  });
  expect(
    decisionBodyAllowsDerivedAi({
      source: { allowsDerivedAi: true },
      bodySource: result,
    }),
  ).toBe(false);
  expect(result.provenance.records).toHaveLength(2);
});

test("unknown legacy observation time remains explicitly unknown", () => {
  const known = publicationProvenanceOf(
    publication("legacy"),
    COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
  );
  const primary = { ...known, retrievedAt: null };
  const result = collectionBodySourceOf({
    primary,
    publications: [],
    totalCount: 1,
  });
  expect(v.safeParse(decisionBodySourceSchema, result).success).toBe(true);
  expect(result.retrievedAt).toBeNull();
  expect(result.provenance.records.at(0)?.retrievedAt).toBeNull();
});
