import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  readAdmittedCourtNames,
  readCourtNames,
} from "@/api/handlers/case-law/decisions/shelf-courts";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readNonRedistributableCaseLawSourceIdsQuery } from "@/api/lib/case-law/non-redistributable-sources";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The courts a public surface lists are the courts it may serve: one whose
 * only source the redistribution policy withholds is stored, but never named.
 */

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

const OPEN_COURT = "Krajský súd v Bratislave";
const WITHHELD_COURT = "Súd so zadržaným zdrojom";
const SHARED_COURT = "Najvyšší súd";

const openSourceId = createSafeId<"caseLawSource">();
const withheldSourceId = createSafeId<"caseLawSource">();

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

// timeout: an embedded Postgres pushes the whole schema before the seed.
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
      caseLawSourceRow({ adapterKey: "open", id: openSourceId, name: "open" }),
      caseLawSourceRow({
        adapterKey: "withheld",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: null,
          license: "restricted",
        },
        id: withheldSourceId,
        name: "withheld",
      }),
    ]);
    await db.insert(caseLawDecisions).values([
      {
        caseNumber: "open",
        country: "SVK",
        court: OPEN_COURT,
        language: "sk",
        sourceId: openSourceId,
      },
      {
        caseNumber: "withheld only",
        country: "SVK",
        court: WITHHELD_COURT,
        language: "sk",
        sourceId: withheldSourceId,
      },
      {
        caseNumber: "shared, open",
        country: "SVK",
        court: SHARED_COURT,
        language: "sk",
        sourceId: openSourceId,
      },
      {
        caseNumber: "shared, withheld",
        country: "SVK",
        court: SHARED_COURT,
        language: "sk",
        sourceId: withheldSourceId,
      },
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

// timeout: the population view and the vocabulary walk run on an embedded Postgres.
test(
  "a court whose only source is withheld is stored but not admitted",
  async () => {
    const excludedSourceIds = await caseLawDb(
      readNonRedistributableCaseLawSourceIdsQuery,
    );
    expect(excludedSourceIds).toEqual([withheldSourceId]);

    // The join-free vocabulary holds every stored court, the withheld one too.
    expect(
      (await readCourtNames({ caseLawDb, country: "SVK" })).toSorted(),
    ).toEqual([OPEN_COURT, SHARED_COURT, WITHHELD_COURT].toSorted());

    const admitted = await readAdmittedCourtNames({
      caseLawDb,
      country: "SVK",
      excludedSourceIds,
    });
    expect([...admitted].toSorted()).toEqual(
      [OPEN_COURT, SHARED_COURT].toSorted(),
    );
    expect(admitted.has(WITHHELD_COURT)).toBe(false);
  },
  DB_TEST_TIMEOUT_MS,
);
