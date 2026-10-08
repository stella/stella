import type { PGlite } from "@electric-sql/pglite";
/**
 * Each page of the expression id backfill must read a bounded, index-backed
 * slice of `legislation_documents`, however large the table grows: the page's
 * ids walk the primary key and stop at the limit, the unclaimed rows are a
 * primary-key range, the claim finds its rows by primary key, and the per-row
 * twin and sibling probes seek the row's work by its identifier. A sequential
 * scan, a sort, a whole-index read, or a hashed subplan or anti-join over the
 * table would make every page, and so every pass, read all of it.
 *
 * The fixture has the production shape: sources with and without a
 * namespace, two of them sharing identifiers, works with many versions, rows
 * without a version IRI, rows already claimed, and ids that interleave the
 * sources. The plans are checked under the physical statistics and again with
 * the table scaled to the synthetic profile's size, and the same statements
 * run against the fixture so the index path is also the correct answer.
 */
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import type { Transaction } from "@/api/db/root";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  claimExpressionIdsQuery,
  expressionIdPageQuery,
  unclaimedExpressionIdRowsQuery,
} from "@/api/lib/scheduler/tasks/legislation-expression-id-backfill";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";
import type { ScanOccurrence } from "@/api/tests/query-plans/plan-walker";
import {
  scaleTableToProfile,
  SYNTHETIC_SCALE_PROFILE,
} from "@/api/tests/query-plans/scale-profile";

const DB_TEST_TIMEOUT_MS = 120_000;
const TABLE = "legislation_documents";
const PRIMARY_KEY = "legislation_documents_pkey";
/** The indexes that seek one work's rows by its identifier. */
const WORK_INDEXES: readonly string[] = [
  "legislation_documents_eli_idx",
  "legislation_documents_eli_lang_valid_from_idx",
];
const INDEX_SCANS: readonly string[] = [
  "Index Scan",
  "Index Only Scan",
  "Bitmap Heap Scan",
];
/** A probe's seek key: the outer row's work identifier. */
const WORK_SEEK = `((eli)::text = (${TABLE}.eli)::text)`;

/** The task's default page. */
const PAGE_ROWS = 1000;
/** Where the resumed page's cursor sits, in id order. */
const CURSOR_AT = 9000;
const VERSIONS = 12;
const INSERT_BATCH = 500;
const ID_PREFIX = "00000000-0000-7000-8c00-";
/** Coprime with the row count, so ids interleave sources and works. */
const ID_STRIDE = 7919;

type SourceShape = {
  id: SafeId<"legislationSource">;
  namespace: string | null;
  works: number;
  versions: number;
};

const SOURCES = [
  {
    id: toSafeId<"legislationSource">("0198e331-e578-7000-8000-000000000c01"),
    namespace: "plan",
    works: 1000,
    versions: VERSIONS,
  },
  // Shares every identifier with the first: a probe keyed on the identifier
  // alone meets both sources' rows.
  {
    id: toSafeId<"legislationSource">("0198e331-e578-7000-8000-000000000c02"),
    namespace: "other",
    works: 1000,
    versions: VERSIONS,
  },
  {
    id: toSafeId<"legislationSource">("0198e331-e578-7000-8000-000000000c03"),
    namespace: null,
    works: 200,
    versions: 5,
  },
] as const satisfies readonly SourceShape[];

type FixtureRow = {
  id: SafeId<"legislationDocument">;
  sourceId: SafeId<"legislationSource">;
  namespace: string | null;
  eli: string;
  versionValidFrom: string;
  versionIri: string | null;
  publisherExpressionId: string | null;
};

const iri = (work: number, version: number) =>
  `https://example.test/eli/plan/${work}/v${version}`;

/**
 * The version IRI a row stores. Some works repeat one version's IRI on the
 * next: a pair of unclaimed twins, or a row naming a version another row
 * already claimed.
 */
const versionIriOf = (work: number, version: number): string | null => {
  if ((work + version) % 23 === 0) {
    return null;
  }
  if (work % 97 === 5 && version === 2) {
    return iri(work, 1);
  }
  if (work % 89 === 7 && version === 4) {
    return iri(work, 3);
  }
  return iri(work, version);
};

const fixtureRows = (): FixtureRow[] => {
  const shapes = SOURCES.flatMap((source) =>
    Array.from({ length: source.works * source.versions }, (_, index) => ({
      source,
      work: index % source.works,
      version: Math.floor(index / source.works),
    })),
  );
  return shapes.map(({ source, work, version }, index) => {
    const versionIri = versionIriOf(work, version);
    const claimed =
      source.namespace !== null && versionIri !== null && version % 3 === 0;
    const position = ((index * ID_STRIDE) % shapes.length) + 1;
    return {
      id: toSafeId<"legislationDocument">(
        `${ID_PREFIX}${String(position).padStart(12, "0")}`,
      ),
      sourceId: source.id,
      namespace: source.namespace,
      eli: `eli/plan/${work}`,
      versionValidFrom: `2000-01-${String(version + 1).padStart(2, "0")}`,
      versionIri,
      publisherExpressionId: claimed
        ? `${source.namespace}:${versionIri}`
        : null,
    };
  });
};

const rows = fixtureRows();
const rowsById = new Map(rows.map((row) => [row.id, row]));
/** Every id in the table's order. */
const orderedIds = rows.map(({ id }) => id).toSorted();

/** Rows in id order: uuids compare as their text, not as words. */
const byId = (a: { id: string }, b: { id: string }) =>
  Number(a.id > b.id) - Number(a.id < b.id);

const workRows = Map.groupBy(rows, (row) => `${row.sourceId} ${row.eli}`);

/** Why the task leaves a row unclaimed, read from the fixture alone. */
const expectedSkipReason = (row: FixtureRow): string | null => {
  if (row.namespace === null) {
    return "no-namespace";
  }
  if (row.versionIri === null) {
    return "no-version-iri";
  }
  const publisherId = `${row.namespace}:${row.versionIri}`;
  const ambiguous = (workRows.get(`${row.sourceId} ${row.eli}`) ?? []).some(
    (other) =>
      (other.id !== row.id &&
        other.publisherExpressionId === null &&
        other.versionIri === row.versionIri) ||
      other.publisherExpressionId === publisherId,
  );
  return ambiguous ? "ambiguous-id" : null;
};

const pageCursor = (at: number): SafeId<"legislationDocument"> =>
  orderedIds[at] ?? panic("fixture has no row at the cursor");

/** The last id of the page after the cursor at `cursorAt`. */
const pageLast = (cursorAt: number | null): SafeId<"legislationDocument"> =>
  orderedIds[(cursorAt ?? -1) + PAGE_ROWS] ??
  panic("fixture has no full page there");

/** The page's unclaimed rows, with the reason each is skipped. */
const expectedUnclaimed = (cursorAt: number | null) =>
  orderedIds
    .slice((cursorAt ?? -1) + 1, (cursorAt ?? -1) + 1 + PAGE_ROWS)
    .flatMap((id) => {
      const row = rowsById.get(id) ?? panic("fixture row is missing");
      return row.publisherExpressionId === null
        ? [{ id, skipReason: expectedSkipReason(row) }]
        : [];
    });

let client: PGlite;
let db: ReturnType<typeof drizzle>;

/** Run `fn` in a root transaction, typed as the production one. */
const asRoot = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (rootTx) => {
    // SAFETY: the PGlite transaction exposes the production root query surface.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test transaction stands in for the production root transaction
    const tx = rootTx as unknown as Transaction;
    return await fn(tx);
  });

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(legislationSources).values(
      SOURCES.map(({ id, namespace }) => ({
        id,
        adapterKey: `expression-plan-${id.slice(-2)}`,
        name: `Expression plan ${id.slice(-2)}`,
        expressionNamespace: namespace,
      })),
    );
    for (const itemBatch of chunkItems(rows, INSERT_BATCH)) {
      await db.insert(legislationDocuments).values(
        itemBatch.map((row) => ({
          id: row.id,
          sourceId: row.sourceId,
          eli: row.eli,
          title: `Act ${row.eli}`,
          country: "CZE",
          language: "cs",
          versionValidFrom: row.versionValidFrom,
          publisherExpressionId: row.publisherExpressionId,
          metadata:
            row.versionIri === null ? {} : { versionIri: row.versionIri },
        })),
      );
    }
    await db.execute(sql`VACUUM (ANALYZE) legislation_documents`);
    await db.execute(sql`ANALYZE legislation_sources`);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  try {
    // Dropping the fixture also releases its indexes before the next file runs.
    await db.execute(sql`DROP TABLE legislation_documents CASCADE`);
    const { rows: relations } = await db.execute(sql`
      SELECT to_regclass('public.legislation_documents') AS relation
    `);
    expect(relations).toEqual([{ relation: null }]);
  } finally {
    rows.length = 0;
    rowsById.clear();
    orderedIds.length = 0;
    workRows.clear();
    await client.close();
  }
  expect(client.closed).toBe(true);
});

type PlanNode = Record<string, unknown>;

const planNodes = (node: PlanNode): PlanNode[] => {
  const children = node["Plans"];
  if (children === undefined) {
    return [node];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("EXPLAIN plan has malformed children");
  }
  return [node, ...children.flatMap(planNodes)];
};

const explain = async (
  build: (tx: Transaction) => SQLWrapper,
): Promise<PlanNode> =>
  await asRoot(async (tx) =>
    explainRoot(
      await tx.execute(sql`EXPLAIN (FORMAT JSON) ${build(tx).getSQL()}`),
    ),
  );

/** The statement's scans of the documents table, by alias. */
const documentScans = (root: PlanNode): Map<string | null, ScanOccurrence> => {
  const scans = scanOccurrences(root).filter(
    ({ relation }) => relation === TABLE,
  );
  const byAlias = new Map(scans.map((scan) => [scan.alias, scan]));
  expect(byAlias.size).toBe(scans.length);
  return byAlias;
};

/** An index path over `indexes` whose condition carries every seek key. */
const expectSeek = (
  scan: ScanOccurrence | undefined,
  indexes: readonly string[],
  keys: readonly string[],
) => {
  expect(INDEX_SCANS).toContain(scan?.nodeType ?? "missing");
  expect(indexes).toContain(scan?.index ?? "missing");
  for (const key of keys) {
    expect(scan?.indexCond ?? "").toContain(key);
  }
};

/** No sort, and no subplan hashed from a scan of the whole table. */
const expectNoWholeTableWork = (root: PlanNode) => {
  const nodes = planNodes(root);
  expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
  expect(
    nodes.flatMap((node) => {
      const name = node["Subplan Name"];
      return typeof name === "string" && name.startsWith("hashed")
        ? [name]
        : [];
    }),
  ).toEqual([]);
};

const afterKey = (cursor: SafeId<"legislationDocument">) =>
  `(id > '${cursor}'::uuid)`;
const throughKey = (last: SafeId<"legislationDocument">) =>
  `(id <= '${last}'::uuid)`;

const expectPagePlan = async (cursorAt: number | null) => {
  const cursor = cursorAt === null ? null : pageCursor(cursorAt);
  const root = await explain((tx) =>
    expressionIdPageQuery(tx, cursor, PAGE_ROWS),
  );
  // The limit sits directly on the key-ordered walk: nothing past the page
  // is read, and nothing is sorted.
  const nodes = planNodes(root);
  expect(nodes.map((node) => node["Node Type"])).toEqual([
    "Limit",
    expect.any(String),
  ]);
  const scans = documentScans(root);
  expect([...scans.keys()]).toEqual([TABLE]);
  expectSeek(
    scans.get(TABLE),
    [PRIMARY_KEY],
    cursor === null ? [] : [afterKey(cursor)],
  );
  expect(["Index Scan", "Index Only Scan"]).toContain(
    scans.get(TABLE)?.nodeType ?? "missing",
  );
};

const expectUnclaimedPlan = async (cursorAt: number | null) => {
  const cursor = cursorAt === null ? null : pageCursor(cursorAt);
  const last = pageLast(cursorAt);
  const root = await explain((tx) =>
    unclaimedExpressionIdRowsQuery(tx, cursor, last),
  );
  expectNoWholeTableWork(root);
  const scans = documentScans(root);
  expect(new Set(scans.keys())).toEqual(new Set([TABLE, "sibling", "twin"]));
  expectSeek(
    scans.get(TABLE),
    [PRIMARY_KEY],
    cursor === null ? [throughKey(last)] : [afterKey(cursor), throughKey(last)],
  );
  expectSeek(scans.get("twin"), WORK_INDEXES, [WORK_SEEK]);
  expectSeek(scans.get("sibling"), WORK_INDEXES, [WORK_SEEK]);
};

/** The resumed page's claimable ids, per the fixture. */
const claimableIds = () =>
  expectedUnclaimed(CURSOR_AT)
    .filter(({ skipReason }) => skipReason === null)
    .map(({ id }) => id);

const expectClaimPlan = async () => {
  const claimable = claimableIds();
  const root = await explain((tx) => claimExpressionIdsQuery(tx, claimable));
  const scans = documentScans(root);
  expect(new Set(scans.keys())).toEqual(new Set([TABLE, "sibling"]));
  expectSeek(scans.get(TABLE), [PRIMARY_KEY], ["id"]);
  expectSeek(scans.get("sibling"), WORK_INDEXES, [WORK_SEEK]);
  // The sibling re-check stays a per-row probe: an anti-join is free to hash
  // the whole table instead.
  expectNoWholeTableWork(root);
  const nodes = planNodes(root);
  expect(nodes.map((node) => node["Node Type"])).not.toContain("Hash");
  expect(
    nodes.flatMap((node) => {
      const joinType = node["Join Type"];
      return typeof joinType === "string" && joinType.includes("Anti")
        ? [joinType]
        : [];
    }),
  ).toEqual([]);
};

const expectBoundedPlans = async () => {
  await expectPagePlan(null);
  await expectPagePlan(CURSOR_AT);
  await expectUnclaimedPlan(null);
  await expectUnclaimedPlan(CURSOR_AT);
  await expectClaimPlan();
};

test(
  "each page reads a primary-key range, seeks each row's work by its identifier, and claims by key",
  async () => {
    await expectBoundedPlans();
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the page reads answer from the fixture in id order, with every skip reason",
  async () => {
    for (const cursorAt of [null, CURSOR_AT]) {
      const cursor = cursorAt === null ? null : pageCursor(cursorAt);
      const page = await asRoot(
        async (tx) => await expressionIdPageQuery(tx, cursor, PAGE_ROWS),
      );
      const start = (cursorAt ?? -1) + 1;
      expect(page.map(({ id }): string => id)).toEqual(
        orderedIds.slice(start, start + PAGE_ROWS),
      );

      const unclaimed = await asRoot(
        async (tx) =>
          await unclaimedExpressionIdRowsQuery(tx, cursor, pageLast(cursorAt)),
      );
      const expected = expectedUnclaimed(cursorAt);
      expect(unclaimed.toSorted(byId)).toEqual(expected);
      // The fixture reaches every branch the page can take.
      expect(new Set(expected.map(({ skipReason }) => skipReason))).toEqual(
        new Set([null, "no-namespace", "no-version-iri", "ambiguous-id"]),
      );
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the page plans stay bounded when the table and its indexes are scaled up",
  async () => {
    await scaleTableToProfile(db, TABLE, SYNTHETIC_SCALE_PROFILE);
    await expectBoundedPlans();
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the claim gives each claimable row the id its version IRI proves, once",
  async () => {
    const unclaimed = expectedUnclaimed(CURSOR_AT);
    const claimable = claimableIds();
    expect(claimable.length).toBeGreaterThan(0);

    const claimed = await asRoot(
      async (tx) => await claimExpressionIdsQuery(tx, claimable),
    );
    expect(claimed.map(({ id }): string => id).toSorted()).toEqual(claimable);

    const stored = await db
      .select({
        id: legislationDocuments.id,
        publisherId: legislationDocuments.publisherExpressionId,
      })
      .from(legislationDocuments)
      .where(
        inArray(
          legislationDocuments.id,
          unclaimed.map(({ id }) => id),
        ),
      );
    // Claimed rows carry their proven id; skipped rows are left as they were.
    expect(stored.toSorted(byId)).toEqual(
      unclaimed.map(({ id, skipReason }) => {
        const row = rowsById.get(id) ?? panic("fixture row is missing");
        return {
          id,
          publisherId:
            skipReason === null
              ? `${row.namespace ?? ""}:${row.versionIri ?? ""}`
              : null,
        };
      }),
    );

    // A replay finds the ids already stored and claims nothing again.
    expect(
      await asRoot(async (tx) => await claimExpressionIdsQuery(tx, claimable)),
    ).toEqual([]);
  },
  DB_TEST_TIMEOUT_MS,
);
