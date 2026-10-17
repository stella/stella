import { expect, test } from "bun:test";

import { LegislationRevision } from "@/api/handlers/legislation/revision";
import { createSafeId } from "@/api/lib/branded-types";
import { sanitizeLegislationAmendments } from "@/api/lib/legal-search/legislation-amendments";
import type {
  LegislationAmendmentSnapshot,
  LegislationDocumentInput,
} from "@/api/lib/legal-search/legislation-ingestion-types";

const snapshot = {
  observedAt: "2026-10-16T10:00:00Z",
  relations: [
    {
      publisherId: "publisher:1",
      amendingEli: "eli/cz/sb/2026/159",
      amendingTitle: "Act\u0000 159",
      amendingAnchor: null,
      affectedAnchor: "https://example.test#1830a",
      changeKind: "inserted",
      effective: { type: "date", on: "2027-01-01" },
      publisherInstruction: "insert",
    },
  ],
  coverage: { type: "complete" },
} satisfies LegislationAmendmentSnapshot;
const document = {
  sourceId: createSafeId<"legislationSource">(),
  eli: "eli/cz/sb/2012/89",
  title: "Act 89",
  country: "CZE",
  language: "cs",
  version: { type: "unversioned" },
  rawHash: "raw",
  amendments: snapshot,
} satisfies LegislationDocumentInput;
const classification = {
  expressionKind: "unversioned",
  windowDisposition: "effective",
  windowDispositionBasis: null,
} as const;

test("amendment source hashes follow effects and coverage while identical newer observations preserve the hash", () => {
  const original = new LegislationRevision(document);
  const later = new LegislationRevision({
    ...document,
    amendments: { ...snapshot, observedAt: "2026-10-17T10:00:00Z" },
  });
  expect(original.input.amendments?.relations.at(0)?.amendingTitle).toBe(
    "Act 159",
  );
  expect(original.sourceHash(classification)).toBe(
    later.sourceHash(classification),
  );
  const changes = [
    { ...snapshot, relations: [] },
    {
      ...snapshot,
      relations: snapshot.relations.map((relation) => ({
        ...relation,
        affectedAnchor: "https://example.test#1830b",
      })),
    },
    {
      ...snapshot,
      relations: snapshot.relations.map((relation) => ({
        ...relation,
        effective: { type: "date", on: "2027-07-01" },
      })),
    },
    {
      ...snapshot,
      coverage: {
        type: "partial",
        unlocatedRelations: 1,
        reason: "Publisher omits fragment",
      },
    },
  ] satisfies LegislationAmendmentSnapshot[];
  for (const amendments of changes) {
    expect(
      new LegislationRevision({ ...document, amendments }).sourceHash(
        classification,
      ),
    ).not.toBe(original.sourceHash(classification));
  }
});
test("amendment snapshots reject collisions and impossible coverage before persistence", () => {
  expect(() =>
    sanitizeLegislationAmendments({
      ...snapshot,
      relations: [...snapshot.relations, ...snapshot.relations],
    }),
  ).toThrow("empty or duplicate identity");
  expect(() =>
    sanitizeLegislationAmendments({
      ...snapshot,
      coverage: { type: "not-stated", reason: "No publisher field" },
    }),
  ).toThrow("cannot carry relations");
  expect(() =>
    sanitizeLegislationAmendments({
      ...snapshot,
      coverage: {
        type: "partial",
        unlocatedRelations: 0,
        reason: "Missing fragment",
      },
    }),
  ).toThrow("unlocated relation count");
});
