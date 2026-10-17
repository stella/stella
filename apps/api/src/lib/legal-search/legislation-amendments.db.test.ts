import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, getTableName, sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  legislationAmendments,
  legislationAmendmentSnapshots,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";
import { toSafeId } from "@/api/lib/branded-types";
import {
  readLegislationAmendments,
  readLegislationAmendmentSnapshot,
  sanitizeLegislationAmendments,
  syncLegislationAmendmentsTx,
} from "@/api/lib/legal-search/legislation-amendments";
import type {
  LegislationAmendmentRelation,
  LegislationAmendmentSnapshot,
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
): LegislationAmendmentSnapshot =>
  sanitizeLegislationAmendments({
    observedAt,
    relations,
    coverage: { type: "complete" },
  });
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const sync = async (input: LegislationAmendmentSnapshot) =>
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
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
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
    } finally {
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
      await sync({
        observedAt: "2026-10-18T10:00:00Z",
        relations: [],
        coverage: {
          type: "not-stated",
          reason: "No relation model in this source channel",
        },
      }),
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
    await sync({
      observedAt: "2026-10-18T10:00:00Z",
      relations: [],
      coverage: {
        type: "not-stated",
        reason: "No relation model in this source channel",
      },
    });
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
