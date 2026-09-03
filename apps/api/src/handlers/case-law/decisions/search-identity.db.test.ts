import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { findDecisionIdsByIdentity } from "@/api/handlers/case-law/decisions/search";
import { citationKeyOf } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const sourceId = createSafeId<"caseLawSource">();
const plenaryId = createSafeId<"caseLawDecision">();
const supremeId = createSafeId<"caseLawDecision">();

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

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
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db
      .insert(caseLawSources)
      .values([
        caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      ]);
    await db.insert(caseLawDecisions).values([
      {
        id: plenaryId,
        sourceId,
        // As the publisher prints it: no space after the abbreviation.
        caseNumber: "Pl.ÚS 24/10",
        citationKey: citationKeyOf("Pl.ÚS 24/10"),
        ecli: "ECLI:CZ:US:2011:PL.US.24.10.1",
        court: "Ústavní soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "identity-plenary",
      },
      {
        id: supremeId,
        sourceId,
        caseNumber: "23 Cdo 1572/2012",
        citationKey: citationKeyOf("23 Cdo 1572/2012"),
        ecli: "ECLI:CZ:NS:2012:23.CDO.1572.2012.1",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "identity-supreme",
      },
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test("a docket resolves by its citation key however the reader spaces it", async () => {
  const spaced = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "CZE",
    identity: { type: "identifier", kind: "docket", value: "Pl. ÚS 24/10" },
  });
  expect(spaced).toEqual([plenaryId]);

  const unscoped = await findDecisionIdsByIdentity({
    caseLawDb,
    country: undefined,
    identity: { type: "identifier", kind: "docket", value: "23 Cdo 1572/2012" },
  });
  expect(unscoped).toEqual([supremeId]);
});

test("an ECLI resolves by equality regardless of the reader's case", async () => {
  const ids = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "CZE",
    identity: {
      type: "identifier",
      kind: "ecli",
      value: "ecli:cz:ns:2012:23.cdo.1572.2012.1",
    },
  });
  expect(ids).toEqual([supremeId]);
});

test("an identifier nobody holds, or held in another jurisdiction, resolves to nothing", async () => {
  const unknown = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "CZE",
    identity: { type: "identifier", kind: "docket", value: "22 Cdo 1/2026" },
  });
  expect(unknown).toEqual([]);

  const elsewhere = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "SVK",
    identity: { type: "identifier", kind: "docket", value: "Pl. ÚS 24/10" },
  });
  expect(elsewhere).toEqual([]);
});
