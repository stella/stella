import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { eq, getTableName, sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationAmendments,
  legislationAmendmentSnapshots,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { processLegislationDocument } from "@/api/handlers/legislation/ingestion";
import type { LegislationCorpusDependencies } from "@/api/handlers/legislation/ingestion";
import { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";
import { toSafeId } from "@/api/lib/branded-types";
import {
  LEGISLATION_AMENDMENT_PAGE_MAX,
  LEGISLATION_AMENDMENT_SNAPSHOT_MAX,
  readLegislationAmendments,
  readLegislationAmendmentSnapshot,
  sanitizeLegislationAmendments,
  syncLegislationAmendmentsTx,
} from "@/api/lib/legal-search/legislation-amendments";
import type {
  LegislationAmendmentObservationErrorReason,
  SanitizedLegislationAmendmentSnapshot,
} from "@/api/lib/legal-search/legislation-amendments";
import type {
  LegislationAmendmentRelation,
  LegislationAmendmentSnapshot,
  LegislationDocumentInput,
} from "@/api/lib/legal-search/legislation-ingestion-types";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION } from "@/api/lib/public-law-relations";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const sourceId = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000001a01",
);
const work = { sourceId, eli: "eli/cz/sb/2012/89", language: "cs" };
const documentId = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000001a02",
);
// Neutral model of an insertion, not a captured publisher response.
const relation = {
  publisherId: "publisher:159-2026-1",
  amendingEli: "eli/cz/sb/2026/159",
  amendingTitle: "Act 159/2026",
  amendingAnchor: "https://example.test/2026/159#article-I-point-1",
  affectedAnchor: "https://example.test/2012/89#section-1830a",
  changeKind: "inserted",
  effective: { type: "date", on: "2027-01-01" },
  publisherInstruction: "insert",
} satisfies LegislationAmendmentRelation;
const snapshot = (
  observedAt: string,
  relations: LegislationAmendmentRelation[],
): SanitizedLegislationAmendmentSnapshot =>
  sanitizeLegislationAmendments({
    observedAt,
    relations,
    coverage: { type: "complete" },
  }).unwrap();
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
const corpus = {
  mode: "off",
  write: async () =>
    await Promise.resolve({
      type: "skipped-empty" as const,
      written: null,
      contentHash: "0".repeat(64),
    }),
} satisfies LegislationCorpusDependencies;
const sync = async (input: SanitizedLegislationAmendmentSnapshot) =>
  await db.transaction(
    async (tx) =>
      await syncLegislationAmendmentsTx(asTestRaw(tx), {
        work,
        snapshot: input,
      }),
  );
const incoming = async (limit = 10, cursor: string | null = null) =>
  await readLegislationAmendments(asTestRaw(db), {
    work,
    direction: "incoming",
    limit,
    cursor,
  });

const rejectedSnapshots = (): {
  reason: LegislationAmendmentObservationErrorReason;
  snapshot: LegislationAmendmentSnapshot;
}[] => [
  {
    reason: "invalid_observed_at",
    snapshot: {
      observedAt: "bad",
      relations: [],
      coverage: { type: "complete" },
    },
  },
  {
    reason: "relation_limit_exceeded",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: Array.from(
        { length: LEGISLATION_AMENDMENT_SNAPSHOT_MAX + 1 },
        (_, index) => ({ ...relation, publisherId: String(index) }),
      ),
      coverage: { type: "complete" },
    },
  },
  {
    reason: "empty_publisher_id",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [{ ...relation, publisherId: "\u0000" }],
      coverage: { type: "complete" },
    },
  },
  {
    reason: "duplicate_publisher_id",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [relation, relation],
      coverage: { type: "complete" },
    },
  },
  {
    reason: "empty_amending_eli",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [{ ...relation, amendingEli: "\u0000" }],
      coverage: { type: "complete" },
    },
  },
  {
    // Incompressible on purpose: TOAST compression cannot shrink it under the
    // index entry limit, which is what made an unbounded identity unsafe.
    reason: "publisher_id_too_long",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [
        {
          ...relation,
          publisherId: Array.from({ length: 3000 }, (_, index) =>
            String.fromCodePoint(0x4e_00 + ((index * 7919) % 20_000)),
          ).join(""),
        },
      ],
      coverage: { type: "complete" },
    },
  },
  {
    reason: "amending_eli_too_long",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [{ ...relation, amendingEli: `eli/cz/sb/${"9".repeat(503)}` }],
      coverage: { type: "complete" },
    },
  },
  {
    reason: "empty_affected_anchor",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [{ ...relation, affectedAnchor: "\u0000" }],
      coverage: { type: "complete" },
    },
  },
  {
    reason: "invalid_effective_date",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [
        { ...relation, effective: { type: "date", on: "2027-02-30" } },
      ],
      coverage: { type: "complete" },
    },
  },
  {
    reason: "incomplete_coverage_without_reason",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [],
      coverage: { type: "not-stated", reason: "\u0000" },
    },
  },
  {
    reason: "invalid_partial_unlocated_relations",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [],
      coverage: { type: "partial", reason: "missing", unlocatedRelations: 0 },
    },
  },
  {
    reason: "unstated_coverage_with_relations",
    snapshot: {
      observedAt: "2026-10-18T10:00:00Z",
      relations: [relation],
      coverage: { type: "not-stated", reason: "No relation model" },
    },
  },
];
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
});
beforeEach(async () => {
  await db
    .delete(legislationSources)
    .where(eq(legislationSources.id, sourceId));
  await db.insert(legislationSources).values({
    id: sourceId,
    name: "Amendment fixture",
    adapterKey: "amendment-fixture",
  });
  await db.insert(legislationDocuments).values({
    id: documentId,
    sourceId,
    eli: work.eli,
    title: "Civil Code",
    country: "CZE",
    language: work.language,
    contentHash: "a".repeat(64),
    versionValidFrom: "2027-01-01",
  });
});
afterAll(async () => {
  await client.close();
});

describe("publisher amendment snapshots", () => {
  test("every rejected observation stores its statute and preserves the previous snapshot", async () => {
    await sync(snapshot("2026-10-16T11:00:00Z", [relation]));
    const beforeRelations = await incoming();
    const beforeSnapshot = await readLegislationAmendmentSnapshot(
      asTestRaw(db),
      work,
    );

    for (const [index, rejection] of rejectedSnapshots().entries()) {
      const result = await processLegislationDocument(
        {
          sourceId,
          eli: work.eli,
          title: `Civil Code ${index}`,
          country: "CZE",
          language: work.language,
          version: {
            type: "consolidation",
            validFrom: "2027-01-01",
            end: { type: "open" },
          },
          fulltext: `wording ${index}`,
          rawHash: `rejected-observation-${index}`,
          amendments: rejection.snapshot,
        },
        scopedDb,
        { corpus },
      );
      expect(result.type).toBe("stored");
      if (result.type === "stored") {
        expect(result.amendmentObservation.type).toBe("rejected");
        if (result.amendmentObservation.type === "rejected") {
          expect(result.amendmentObservation.error.reason).toBe(
            rejection.reason,
          );
        }
      }
      expect(await incoming()).toEqual(beforeRelations);
      expect(
        await readLegislationAmendmentSnapshot(asTestRaw(db), work),
      ).toEqual(beforeSnapshot);
    }
  });

  test("unchanged ingestion sanitizes a newer amendment observation", async () => {
    const input = {
      sourceId,
      eli: "eli/cz/sb/2012/91",
      title: "Act 91/2012",
      country: "CZE",
      language: "cs",
      version: {
        type: "consolidation",
        validFrom: "2027-01-01",
        end: { type: "open" },
      },
      fulltext: "§ 1",
      rawHash: "unchanged-amendment-contract-v1",
      amendments: {
        observedAt: "2026-10-16T11:00:00Z",
        relations: [relation],
        coverage: { type: "complete" },
      },
    } satisfies LegislationDocumentInput;
    const first = await processLegislationDocument(input, scopedDb, { corpus });
    expect(first).toMatchObject({ type: "stored", skipped: false });

    const stored = await processLegislationDocument(
      {
        ...input,
        amendments: {
          ...input.amendments,
          observedAt: "2026-10-17T11:00:00Z",
          relations: [{ ...relation, amendingTitle: "Act\u0000 159/2026" }],
        },
      },
      scopedDb,
      { corpus },
    );

    expect(stored).toMatchObject({ type: "stored", skipped: true });
    expect(
      (
        await readLegislationAmendments(asTestRaw(db), {
          work: { ...work, eli: input.eli },
          direction: "incoming",
          limit: 10,
        })
      ).items.find(({ publisherId }) => publisherId === relation.publisherId)
        ?.amendingTitle,
    ).toBe("Act 159/2026");
  });

  test("ingestion carries amendment observations through public statute and version reads", async () => {
    const dated = {
      ...relation,
      publisherId: "publisher:201-2026-1",
      amendingEli: "eli/cz/sb/2026/201",
      amendingTitle: "Act 201/2026",
    } satisfies LegislationAmendmentRelation;
    const notStated = {
      ...relation,
      publisherId: "publisher:202-2026-1",
      amendingEli: "eli/cz/sb/2026/202",
      amendingTitle: "Act 202/2026",
      effective: {
        type: "not-stated",
        text: "On the occurrence of the stated event",
      },
    } satisfies LegislationAmendmentRelation;
    const amendments = snapshot("2026-10-16T11:00:00Z", [dated, notStated]);
    const input = {
      sourceId,
      eli: "eli/cz/sb/2012/90",
      title: "Act 90/2012",
      country: "CZE",
      language: "cs",
      version: {
        type: "consolidation",
        validFrom: "2027-01-01",
        end: { type: "open" },
      },
      fulltext: "§ 1",
      rawHash: "amendment-contract-v1",
      amendments,
    } satisfies LegislationDocumentInput;
    const stored = await processLegislationDocument(input, scopedDb, {
      corpus,
    });
    expect(stored.type).toBe("stored");
    if (stored.type !== "stored") {
      throw new Error(`Expected a stored document, got ${stored.type}`);
    }
    const legislationDb: LegislationReadDb = async (read) =>
      await withPublicLawReaderRole(db, async (tx) =>
        read(asTestRaw<LegislationReadTransaction>(tx)),
      );
    const readAmendmentIds = async () => {
      const statute = await readPublicLegislationHandler(
        stored.id,
        legislationDb,
        "pages",
      );
      const versions = await listStatuteVersionsHandler({
        documentId: stored.id,
        query: {},
        legislationDb,
        surface: "pages",
      });
      if ("code" in statute || "code" in versions) {
        throw new Error("Expected amendment reader fixtures to exist");
      }
      return {
        pending: statute.pendingChanges?.items
          .map(({ publisherId }) => publisherId)
          .toSorted(),
        amendedBy: versions.items
          .flatMap(
            ({ amendedBy }) =>
              amendedBy?.items.map(({ publisherId }) => publisherId) ?? [],
          )
          .toSorted(),
      };
    };
    const expected = [dated.publisherId, notStated.publisherId].toSorted();

    setSystemTime(new Date("2026-10-18T10:00:00.000Z"));
    try {
      expect(await readAmendmentIds()).toEqual({
        pending: expected,
        amendedBy: [dated.publisherId],
      });

      await processLegislationDocument(
        { ...input, amendments: undefined },
        scopedDb,
        { corpus },
      );
      expect(await readAmendmentIds()).toEqual({
        pending: expected,
        amendedBy: [dated.publisherId],
      });

      await processLegislationDocument(
        {
          ...input,
          amendments: snapshot("2026-10-17T11:00:00Z", []),
        },
        scopedDb,
        { corpus },
      );
      expect(await readAmendmentIds()).toEqual({ pending: [], amendedBy: [] });
    } finally {
      setSystemTime();
    }
  });

  test("a versions page assigns same-day effects to its default version once", async () => {
    const otherVersionId = toSafeId<"legislationDocument">(
      "0198e331-e578-7000-8000-000000001a03",
    );
    const relations = Array.from(
      { length: LEGISLATION_AMENDMENT_PAGE_MAX },
      (_, index) => ({
        ...relation,
        publisherId: `publisher:same-day-${index.toString().padStart(3, "0")}`,
      }),
    );

    expect(
      await rejectionOf(
        db.transaction(async (tx) => {
          // Production identity constraints normally collapse same-date rows. The
          // handler still defends its response budget while such rows are present.
          await tx.execute(
            sql`DROP INDEX legislation_documents_legacy_version_lang_idx`,
          );
          await tx.insert(legislationDocuments).values({
            id: otherVersionId,
            sourceId,
            eli: work.eli,
            title: "Civil Code as one text",
            country: "CZE",
            language: work.language,
            contentHash: "b".repeat(64),
            versionValidFrom: "2027-01-01",
            expressionKind: "unversioned",
          });
          await syncLegislationAmendmentsTx(asTestRaw(tx), {
            work,
            snapshot: snapshot("2026-10-18T11:00:00Z", relations),
          });
          const versions = await listStatuteVersionsHandler({
            documentId,
            query: {},
            legislationDb: async (read) =>
              await read(asTestRaw<LegislationReadTransaction>(tx)),
            surface: "pages",
          });
          if (!("items" in versions)) {
            throw new Error("Expected same-day version fixtures to exist");
          }

          const projected = versions.items.flatMap(({ id, amendedBy }) =>
            (amendedBy?.items ?? []).map((effect) => ({
              ownerId: id,
              publisherId: effect.publisherId,
            })),
          );
          expect(projected.length).toBeLessThanOrEqual(
            LEGISLATION_AMENDMENT_PAGE_MAX,
          );
          expect(
            projected.map(({ publisherId }) => publisherId).toSorted(),
          ).toEqual(relations.map(({ publisherId }) => publisherId).toSorted());
          expect(
            new Set(projected.map(({ publisherId }) => publisherId)).size,
          ).toBe(LEGISLATION_AMENDMENT_PAGE_MAX);
          expect(
            projected.every(({ ownerId }) => ownerId === otherVersionId),
          ).toBe(true);

          tx.rollback();
        }),
      ),
    ).toBeInstanceOf(TransactionRollbackError);
  });

  test("effects of the look-ahead version never crowd out a returned version", async () => {
    await db.insert(legislationDocuments).values({
      id: toSafeId<"legislationDocument">(
        "0198e331-e578-7000-8000-000000001a04",
      ),
      sourceId,
      eli: work.eli,
      title: "Civil Code",
      country: "CZE",
      language: work.language,
      contentHash: "c".repeat(64),
      versionValidFrom: "2026-01-01",
    });
    const opening = {
      ...relation,
      publisherId: "publisher:z-opening",
    } satisfies LegislationAmendmentRelation;
    const earlier = Array.from(
      { length: LEGISLATION_AMENDMENT_PAGE_MAX },
      (_, index) =>
        ({
          ...relation,
          publisherId: `publisher:a-${index.toString().padStart(3, "0")}`,
          effective: { type: "date", on: "2026-01-01" },
        }) satisfies LegislationAmendmentRelation,
    );
    await sync(snapshot("2026-10-18T11:00:00Z", [...earlier, opening]));

    const versions = await listStatuteVersionsHandler({
      documentId,
      query: { limit: 1 },
      legislationDb: async (read) =>
        await withPublicLawReaderRole(db, async (tx) =>
          read(asTestRaw<LegislationReadTransaction>(tx)),
        ),
      surface: "pages",
    });
    if (!("items" in versions)) {
      throw new Error("Expected version fixtures to exist");
    }

    expect(
      versions.items.map(({ id, amendedBy }) => ({
        id,
        effects: amendedBy?.items.map(({ publisherId }) => publisherId),
      })),
    ).toEqual([{ id: documentId, effects: [opening.publisherId] }]);
  });

  test("public reads tolerate the pre-grant schema and expose amendments after the grant", async () => {
    await sync(snapshot("2026-10-16T11:00:00Z", [relation]));
    const amendmentRelations = [
      getTableName(legislationAmendmentSnapshots),
      getTableName(legislationAmendments),
    ] as const;
    const setAmendmentGrants = async (action: "GRANT" | "REVOKE") => {
      for (const table of amendmentRelations) {
        const columns = Object.keys(
          PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION[table],
        );
        const direction = action === "GRANT" ? "TO" : "FROM";
        await db.execute(
          sql.raw(
            `${action} SELECT (${columns.map((column) => `"${column}"`).join(", ")}) ON TABLE "${table}" ${direction} stella_public_law_reader`,
          ),
        );
      }
    };
    const legislationDb: LegislationReadDb = async (read) =>
      await withPublicLawReaderRole(db, async (tx) =>
        read(asTestRaw<LegislationReadTransaction>(tx)),
      );
    const readBoth = async () => ({
      statute: await readPublicLegislationHandler(
        documentId,
        legislationDb,
        "pages",
      ),
      versions: await listStatuteVersionsHandler({
        documentId,
        query: {},
        legislationDb,
        surface: "pages",
      }),
    });

    // Pending changes are those effective after the legal day; pin the day
    // before the fixture's 2027-01-01 effective date.
    setSystemTime(new Date("2026-10-18T10:00:00.000Z"));
    await setAmendmentGrants("REVOKE");
    try {
      const beforeGrant = await readBoth();
      expect(beforeGrant.statute).toMatchObject({ pendingChanges: null });
      expect(beforeGrant.versions).toMatchObject({
        items: [{ amendedBy: null }],
      });

      await setAmendmentGrants("GRANT");
      const afterGrant = await readBoth();
      expect(afterGrant.statute).toMatchObject({
        pendingChanges: {
          items: [{ publisherId: relation.publisherId }],
        },
      });
      expect(afterGrant.versions).toMatchObject({
        items: [
          { amendedBy: { items: [{ publisherId: relation.publisherId }] } },
        ],
      });

      // On its effective day the amendment is in force, no longer pending.
      setSystemTime(new Date("2027-01-01T10:00:00.000Z"));
      expect(
        await readPublicLegislationHandler(documentId, legislationDb, "pages"),
      ).toMatchObject({ pendingChanges: { items: [] } });
    } finally {
      setSystemTime();
      await setAmendmentGrants("GRANT");
    }
  });

  test("replay and stale observations converge while staged dates and same-day acts retain their identities", async () => {
    const staged = {
      ...relation,
      publisherId: "publisher:159-2026-2",
      affectedAnchor: "https://example.test/2012/89#section-1830b",
      effective: { type: "date", on: "2027-07-01" },
    } satisfies LegislationAmendmentRelation;
    const sameDay = {
      ...relation,
      publisherId: "publisher:160-2026-1",
      amendingEli: "eli/cz/sb/2026/160",
      amendingTitle: "Act 160/2026",
    } satisfies LegislationAmendmentRelation;
    const conditional = {
      ...relation,
      publisherId: "publisher:161-2026-1",
      amendingEli: "eli/cz/sb/2026/161",
      effective: {
        type: "not-stated",
        text: "On the occurrence of the stated event",
      },
    } satisfies LegislationAmendmentRelation;
    const first = snapshot("2026-10-16T10:00:00Z", [
      relation,
      staged,
      sameDay,
      conditional,
    ]);
    expect(await sync(first)).toBe("applied");
    const rows = await incoming();
    expect(rows.items).toHaveLength(4);
    expect(
      rows.items
        .filter((row) => row.effectiveDate === "2027-01-01")
        .map((row) => row.amendingEli)
        .toSorted(),
    ).toEqual([relation.amendingEli, sameDay.amendingEli]);
    expect(
      rows.items.find((row) => row.publisherId === staged.publisherId)
        ?.effectiveDate,
    ).toBe("2027-07-01");
    expect(
      rows.items.find((row) => row.publisherId === conditional.publisherId),
    ).toMatchObject({
      effectiveType: "not-stated",
      effectiveDate: null,
      effectiveText: conditional.effective.text,
    });
    expect(
      await sync(
        sanitizeLegislationAmendments({
          observedAt: "2026-10-18T10:00:00Z",
          relations: [],
          coverage: {
            type: "not-stated",
            reason: "No relation model in this source channel",
          },
        }).unwrap(),
      ),
    ).toBe("not-observed");
    expect(await incoming()).toEqual(rows);
    expect(await sync(first)).toBe("superseded");
    expect(await incoming()).toEqual(rows);
    expect(await sync(snapshot("2026-10-16T11:00:00Z", first.relations))).toBe(
      "applied",
    );
    expect(await sync(snapshot("2026-10-16T10:30:00Z", []))).toBe("superseded");
    expect(await incoming()).toEqual(rows);
    const pending = await readLegislationAmendments(asTestRaw(db), {
      work,
      direction: "incoming",
      limit: 10,
      effectiveAfter: "2027-01-01",
    });
    expect(pending.items.map((row) => row.publisherId)).toEqual([
      staged.publisherId,
      conditional.publisherId,
    ]);
    const outgoing = await readLegislationAmendments(asTestRaw(db), {
      work: { ...work, eli: relation.amendingEli },
      direction: "outgoing",
      limit: 10,
    });
    expect(outgoing.items.map((row) => row.publisherId).toSorted()).toEqual([
      relation.publisherId,
      staged.publisherId,
    ]);
    const firstPage = await incoming(2);
    const secondPage = await incoming(2, firstPage.nextCursor);
    expect([...firstPage.items, ...secondPage.items]).toEqual(rows.items);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      (
        await readLegislationAmendmentSnapshot(asTestRaw(db), work)
      )?.observedAt.toISOString(),
    ).toBe("2026-10-16T11:00:00.000Z");
  });
  test("failed transactions roll back relation effects and the observation watermark", async () => {
    await sync(snapshot("2026-10-16T11:00:00Z", [relation]));
    const before = await incoming();
    expect(
      await rejectionOf(
        db.transaction(async (tx) => {
          await syncLegislationAmendmentsTx(asTestRaw(tx), {
            work,
            snapshot: snapshot("2026-10-17T10:00:00Z", []),
          });
          tx.rollback();
        }),
      ),
    ).toBeInstanceOf(TransactionRollbackError);
    expect(await incoming()).toEqual(before);
    expect(
      (
        await readLegislationAmendmentSnapshot(asTestRaw(db), work)
      )?.observedAt.toISOString(),
    ).toBe("2026-10-16T11:00:00.000Z");
  });
  test("relation-bearing observations supersede an absence-only channel even when fetched earlier", async () => {
    await sync(
      sanitizeLegislationAmendments({
        observedAt: "2026-10-18T10:00:00Z",
        relations: [],
        coverage: {
          type: "not-stated",
          reason: "No relation model in this source channel",
        },
      }).unwrap(),
    );
    expect(await sync(snapshot("2026-10-16T11:00:00Z", [relation]))).toBe(
      "applied",
    );
    expect((await incoming()).items.map((row) => row.publisherId)).toEqual([
      relation.publisherId,
    ]);
  });
  test("a newer empty snapshot clears effects", async () => {
    await sync(snapshot("2026-10-16T11:00:00Z", [relation]));
    await sync(snapshot("2026-10-18T10:00:00Z", []));
    expect((await incoming()).items).toEqual([]);
  });
});
