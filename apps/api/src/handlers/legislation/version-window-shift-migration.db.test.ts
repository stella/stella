import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import nodePath from "node:path";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { defectiveJunctions } from "@/api/handlers/legislation/version-windows";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { installPgliteMigration } from "@/api/tests/pglite-schema";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260922150000_legislation_svk_window_shift/migration.sql",
);

/**
 * The instant the converted Slovak connector started writing, as the migration
 * spells it. A row written at it already carries the half-open convention; the
 * one a second earlier does not. The fixtures sit on both sides of exactly this
 * boundary so moving it cannot go unnoticed.
 */
const CONVERSION_AT = new Date("2026-09-21T20:27:00.000Z");
const BEFORE_CONVERSION = new Date("2026-09-21T20:26:59.000Z");

type Fixture = {
  /** Readable handle used by the assertions. */
  name: string;
  country: string;
  language: string;
  eli: string;
  validFrom: string | null;
  validTo: string | null;
  updatedAt: Date;
  /** `version_valid_to` the migration must leave behind. */
  expectedValidTo: string | null;
};

const FIXTURES: readonly Fixture[] = [
  // Old convention, neighbour-proven: closes the day before its successor opens.
  {
    name: "sk-old-pair/v1",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2020/1",
    validFrom: "2020-01-01",
    validTo: "2021-05-31",
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: "2021-06-01",
  },
  {
    name: "sk-old-pair/v2-open",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2020/1",
    validFrom: "2021-06-01",
    validTo: null,
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: null,
  },
  // Already half-open: the successor opens on the closing date.
  {
    name: "sk-new-pair/v1",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2018/2",
    validFrom: "2018-01-01",
    validTo: "2019-03-15",
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: "2019-03-15",
  },
  {
    name: "sk-new-pair/v2-open",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2018/2",
    validFrom: "2019-03-15",
    validTo: null,
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: null,
  },
  // A chain whose middle consolidation was in force for a single day. Any rule
  // that matched "some version opens on version_valid_to + 1" rather than the
  // immediate successor would shift v1 again on a second run.
  {
    name: "sk-chain/v1",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2019/3",
    validFrom: "2019-01-01",
    validTo: "2019-03-09",
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: "2019-03-10",
  },
  {
    name: "sk-chain/v2-one-day",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2019/3",
    validFrom: "2019-03-10",
    validTo: "2019-03-10",
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: "2019-03-11",
  },
  {
    name: "sk-chain/v3-open",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2019/3",
    validFrom: "2019-03-11",
    validTo: null,
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: null,
  },
  // Closed, no successor, written before the conversion: rule B.
  {
    name: "sk-successor-less-old",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2015/4",
    validFrom: "2015-01-01",
    validTo: "2016-12-31",
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: "2017-01-01",
  },
  // Closed, no successor, written at the conversion instant: already half-open.
  {
    name: "sk-successor-less-new",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2017/5",
    validFrom: "2017-01-01",
    validTo: "2018-01-01",
    updatedAt: CONVERSION_AT,
    expectedValidTo: "2018-01-01",
  },
  // Open window: nothing to shift.
  {
    name: "sk-open",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2014/6",
    validFrom: "2014-01-01",
    validTo: null,
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: null,
  },
  // Overlap and gap: defective or incomplete, but not one day short.
  {
    name: "sk-overlap/v1",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2010/7",
    validFrom: "2010-01-01",
    validTo: "2011-07-01",
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: "2011-07-01",
  },
  {
    name: "sk-overlap/v2-open",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2010/7",
    validFrom: "2011-06-01",
    validTo: null,
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: null,
  },
  {
    name: "sk-gap/v1",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2012/8",
    validFrom: "2012-01-01",
    validTo: "2013-01-01",
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: "2013-01-01",
  },
  {
    name: "sk-gap/v2-open",
    country: "SVK",
    language: "sk",
    eli: "eli/sk/zz/2012/8",
    validFrom: "2013-06-01",
    validTo: null,
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: null,
  },
  // The Czech corpus was swept by its own connector; this pair carries the same
  // defect and must survive untouched.
  {
    name: "cz-old-pair/v1",
    country: "CZE",
    language: "cs",
    eli: "eli/cz/sb/2020/9",
    validFrom: "2020-01-01",
    validTo: "2021-05-31",
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: "2021-05-31",
  },
  {
    name: "cz-old-pair/v2-open",
    country: "CZE",
    language: "cs",
    eli: "eli/cz/sb/2020/9",
    validFrom: "2021-06-01",
    validTo: null,
    updatedAt: BEFORE_CONVERSION,
    expectedValidTo: null,
  },
];

const sourceId = createSafeId<"legislationSource">();
const idsByName = new Map<string, SafeId<"legislationDocument">>(
  FIXTURES.map(({ name }) => [name, createSafeId<"legislationDocument">()]),
);
const nameById = new Map([...idsByName].map(([name, id]) => [id, name]));

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const readRows = async () =>
  await db
    .select()
    .from(legislationDocuments)
    .orderBy(asc(legislationDocuments.id));

type Row = Awaited<ReturnType<typeof readRows>>[number];

const rowsByName = (rows: readonly Row[]) =>
  new Map(rows.map((row) => [nameById.get(row.id) ?? row.id, row]));

const applyMigration = async () => {
  await installPgliteMigration({ db, migrationPath: MIGRATION_PATH });
};

/** The defective junctions of every work of one country, by `eli|language`. */
const defectsByWork = (rows: readonly Row[], country: string) => {
  const works = new Map<
    string,
    { validFrom: string; validTo: string | null }[]
  >();
  for (const row of rows) {
    if (row.country !== country || row.versionValidFrom === null) {
      continue;
    }
    const key = `${row.eli}|${row.language}`;
    const windows = works.get(key) ?? [];
    windows.push({
      validFrom: row.versionValidFrom,
      validTo: row.versionValidTo,
    });
    works.set(key, windows);
  }
  return new Map(
    [...works].map(([key, windows]) => [key, defectiveJunctions(windows)]),
  );
};

const junctionTypes = (
  defects: Map<string, ReturnType<typeof defectiveJunctions>>,
) =>
  [...defects]
    .flatMap(([key, found]) =>
      found.map(({ junction }) => `${key} ${junction.type}`),
    )
    .toSorted();

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(legislationSources).values({
      id: sourceId,
      adapterKey: "svk-window-shift-fixture",
      name: "Slovak window shift fixture",
    });
    await db.insert(legislationDocuments).values(
      FIXTURES.map((fixture) => ({
        id:
          idsByName.get(fixture.name) ?? createSafeId<"legislationDocument">(),
        sourceId,
        eli: fixture.eli,
        title: `${fixture.name} consolidation`,
        country: fixture.country,
        language: fixture.language,
        versionValidFrom: fixture.validFrom,
        versionValidTo: fixture.validTo,
        createdAt: fixture.updatedAt,
        updatedAt: fixture.updatedAt,
      })),
    );
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await client.close();
});

test("the migration shifts every Slovak window a publisher closed inclusively, once", async () => {
  const before = await readRows();

  // The fixtures reach the fault the migration repairs.
  expect(junctionTypes(defectsByWork(before, "SVK"))).toEqual([
    "eli/sk/zz/2010/7|sk overlap",
    "eli/sk/zz/2019/3|sk inclusive-end",
    "eli/sk/zz/2019/3|sk inclusive-end",
    "eli/sk/zz/2020/1|sk inclusive-end",
  ]);
  expect(junctionTypes(defectsByWork(before, "CZE"))).toEqual([
    "eli/cz/sb/2020/9|cs inclusive-end",
  ]);

  await applyMigration();

  const after = await readRows();
  const afterByName = rowsByName(after);
  const beforeByName = rowsByName(before);

  for (const fixture of FIXTURES) {
    const row = afterByName.get(fixture.name);
    expect(`${fixture.name}=${String(row?.versionValidTo)}`).toBe(
      `${fixture.name}=${String(fixture.expectedValidTo)}`,
    );
    if (fixture.expectedValidTo !== fixture.validTo) {
      continue;
    }
    // Untouched rows keep every column, `updated_at` included.
    expect(row).toEqual(beforeByName.get(fixture.name));
  }

  // No Slovak work still closes a window the day before its successor opens.
  // The overlap is a different defect and is deliberately still there.
  expect(junctionTypes(defectsByWork(after, "SVK"))).toEqual([
    "eli/sk/zz/2010/7|sk overlap",
  ]);
  // The Czech corpus is not this migration's to repair.
  expect(junctionTypes(defectsByWork(after, "CZE"))).toEqual([
    "eli/cz/sb/2020/9|cs inclusive-end",
  ]);

  await applyMigration();

  expect(await readRows()).toEqual(after);
});
