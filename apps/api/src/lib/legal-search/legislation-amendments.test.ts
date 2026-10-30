import { expect, test } from "bun:test";

import { LegislationRevision } from "@/api/handlers/legislation/revision";
import { createSafeId } from "@/api/lib/branded-types";
import {
  LEGISLATION_AMENDMENT_SNAPSHOT_MAX,
  sanitizeLegislationAmendments,
} from "@/api/lib/legal-search/legislation-amendments";
import type { LegislationAmendmentObservationErrorReason } from "@/api/lib/legal-search/legislation-amendments";
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
test("publisher amendment faults return every typed rejection reason", () => {
  const relation = snapshot.relations.at(0);
  if (relation === undefined) {
    throw new Error("expected the amendment fixture to carry a relation");
  }
  const cases: {
    reason: LegislationAmendmentObservationErrorReason;
    input: LegislationAmendmentSnapshot;
  }[] = [
    {
      reason: "invalid_observed_at",
      input: { ...snapshot, observedAt: "bad" },
    },
    {
      reason: "relation_limit_exceeded",
      input: {
        ...snapshot,
        relations: Array.from(
          { length: LEGISLATION_AMENDMENT_SNAPSHOT_MAX + 1 },
          (_, index) => ({ ...relation, publisherId: String(index) }),
        ),
      },
    },
    {
      reason: "empty_publisher_id",
      input: {
        ...snapshot,
        relations: [{ ...relation, publisherId: "\u0000" }],
      },
    },
    {
      reason: "duplicate_publisher_id",
      input: { ...snapshot, relations: [relation, relation] },
    },
    {
      reason: "empty_amending_eli",
      input: {
        ...snapshot,
        relations: [{ ...relation, amendingEli: "\u0000" }],
      },
    },
    {
      reason: "publisher_id_too_long",
      input: {
        ...snapshot,
        relations: [{ ...relation, publisherId: "p".repeat(513) }],
      },
    },
    {
      reason: "amending_eli_too_long",
      input: {
        ...snapshot,
        relations: [
          { ...relation, amendingEli: `eli/cz/sb/${"č".repeat(503)}` },
        ],
      },
    },
    {
      reason: "empty_affected_anchor",
      input: {
        ...snapshot,
        relations: [{ ...relation, affectedAnchor: "\u0000" }],
      },
    },
    {
      reason: "invalid_effective_date",
      input: {
        ...snapshot,
        relations: [
          { ...relation, effective: { type: "date", on: "2027-02-30" } },
        ],
      },
    },
    {
      reason: "incomplete_coverage_without_reason",
      input: {
        ...snapshot,
        coverage: { type: "not-stated", reason: "\u0000" },
        relations: [],
      },
    },
    {
      reason: "invalid_partial_unlocated_relations",
      input: {
        ...snapshot,
        coverage: {
          type: "partial",
          unlocatedRelations: 0,
          reason: "Missing fragment",
        },
      },
    },
    {
      reason: "unstated_coverage_with_relations",
      input: {
        ...snapshot,
        coverage: { type: "not-stated", reason: "No publisher field" },
      },
    },
  ];
  for (const { input, reason } of cases) {
    const result = sanitizeLegislationAmendments(input);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe(reason);
      expect(result.error.message).not.toBe("");
    }
  }
});

test("amendment identities are bounded in UTF-8 bytes, not characters", () => {
  const relation = snapshot.relations.at(0);
  if (relation === undefined) {
    throw new Error("expected the amendment fixture to carry a relation");
  }
  // "č" is two UTF-8 bytes: 512 bytes fit, one more byte does not, although
  // either string is far shorter than 512 characters.
  const atBound = `eli/cz/sb/${"č".repeat(251)}`;
  expect(Buffer.byteLength(atBound, "utf-8")).toBe(512);
  const sanitize = (overrides: Partial<typeof relation>) =>
    sanitizeLegislationAmendments({
      ...snapshot,
      relations: [{ ...relation, ...overrides }],
    });
  expect(sanitize({ amendingEli: atBound }).isOk()).toBe(true);
  expect(sanitize({ publisherId: atBound }).isOk()).toBe(true);
  const amendingEli = sanitize({ amendingEli: `${atBound}x` });
  const publisherId = sanitize({ publisherId: `${atBound}x` });
  expect(amendingEli.isErr() && amendingEli.error.reason).toBe(
    "amending_eli_too_long",
  );
  expect(publisherId.isErr() && publisherId.error.reason).toBe(
    "publisher_id_too_long",
  );
});

test("sanitized coverage keeps only the fields of its own kind", () => {
  const widened = (coverage: LegislationAmendmentSnapshot["coverage"]) => ({
    ...snapshot,
    relations: coverage.type === "not-stated" ? [] : snapshot.relations,
    // Adapters live outside this repository; their objects can carry more.
    coverage: { ...coverage, publisherNote: "extra" },
  });
  const cases: LegislationAmendmentSnapshot["coverage"][] = [
    { type: "complete" },
    { type: "partial", unlocatedRelations: 2, reason: "Two unlocated" },
    { type: "not-stated", reason: "No publisher field" },
  ];
  for (const coverage of cases) {
    const result = sanitizeLegislationAmendments(widened(coverage));
    expect(result.isOk() && result.value.coverage).toEqual(coverage);
  }
});

test("amendments of a work whose ELI cannot be indexed beside them are refused, not thrown", () => {
  // "č" is two UTF-8 bytes: the target fits its 512-byte bound at 251 of
  // them after the prefix, and one more byte is refused.
  const atBound = `eli/cz/sb/${"č".repeat(251)}`;
  const observation = (eli: string) =>
    new LegislationRevision({ ...document, eli }).amendmentObservation;
  expect(observation(atBound)).toEqual({ type: "accepted" });
  const refused = observation(`${atBound}x`);
  expect(refused.type === "rejected" && refused.error.reason).toBe(
    "target_eli_too_long",
  );
});
