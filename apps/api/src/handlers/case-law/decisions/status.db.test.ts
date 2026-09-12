import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { readCaseLawCorpusStatusQuery } from "@/api/handlers/case-law/decisions/status";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The timestamp beside the search box is the newest decision the public
 * surface may show: newest of the country rather than of the corpus, of an
 * admitted source rather than of any, and unknown when nothing qualifies.
 */

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

const COUNTRY =
  publicCaseLawCountry("CZE") ?? panic("CZE is a public case-law country");

const openSourceId = createSafeId<"caseLawSource">();
const restrictedSourceId = createSafeId<"caseLawSource">();

const NEWEST_OPEN = "2026-03-04T05:06:07.000Z";
const NEWEST_RESTRICTED = "2026-06-07T08:09:10.000Z";

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the read uses.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    // SAFETY: brand-only wrapper; the read never inspects the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        adapterKey: "open",
        id: openSourceId,
        name: "open",
      }),
      caseLawSourceRow({
        adapterKey: "restricted",
        id: restrictedSourceId,
        name: "restricted",
      }),
    ]);
    // Oldest first, so a read that answers with a row rather than with the
    // newest row cannot pass by luck of the insertion order.
    await db.insert(caseLawDecisions).values([
      {
        caseNumber: "oldest",
        country: "CZE",
        court: "Court",
        language: "cs",
        sourceId: openSourceId,
        updatedAt: new Date("2026-01-02T03:04:05.000Z"),
      },
      {
        caseNumber: "another country, newer still",
        country: "SVK",
        court: "Court",
        language: "sk",
        sourceId: openSourceId,
        updatedAt: new Date("2026-09-10T11:12:13.000Z"),
      },
      {
        caseNumber: "newest open",
        country: "CZE",
        court: "Court",
        language: "cs",
        sourceId: openSourceId,
        updatedAt: new Date(NEWEST_OPEN),
      },
      {
        caseNumber: "newest restricted",
        country: "CZE",
        court: "Court",
        language: "cs",
        sourceId: restrictedSourceId,
        updatedAt: new Date(NEWEST_RESTRICTED),
      },
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

/** The instant the read reported, so the serialized offset is not the subject. */
const readUpdatedAt = async (
  excludedSourceIds: readonly SafeId<"caseLawSource">[],
) => {
  const updatedAt = await caseLawDb(
    async (tx) =>
      await readCaseLawCorpusStatusQuery(tx, {
        country: COUNTRY,
        excludedSourceIds,
      }),
  );
  return updatedAt === null ? null : new Date(updatedAt).toISOString();
};

test(
  "reports the newest decision of its country, not of the corpus",
  async () => {
    expect(await readUpdatedAt([])).toBe(NEWEST_RESTRICTED);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "skips an excluded source's newer decision",
  async () => {
    expect(await readUpdatedAt([restrictedSourceId])).toBe(NEWEST_OPEN);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "reports nothing when no decision is admitted",
  async () => {
    expect(await readUpdatedAt([openSourceId, restrictedSourceId])).toBeNull();
  },
  DB_TEST_TIMEOUT_MS,
);
