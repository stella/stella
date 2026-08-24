import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCorpusJurisdictions } from "@/api/db/schema/case-law";
import { listCaseLawJurisdictions } from "@/api/lib/corpus-index/census";

const MIGRATION = new URL(
  "../../../drizzle/20260825120000_case_law_corpus_jurisdictions/migration.sql",
  import.meta.url,
);
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

test("the jurisdiction registry is seeded and remains derived at the decision write boundary", async () => {
  const client = await PGlite.create();
  try {
    await client.exec(`
      CREATE ROLE stella;
      CREATE ROLE stella_ingestion;
      CREATE TABLE case_law_decisions (
        id uuid PRIMARY KEY,
        country varchar(3) NOT NULL
      );
      CREATE INDEX case_law_decisions_country_idx
        ON case_law_decisions (country);
      INSERT INTO case_law_decisions (id, country) VALUES
        ('00000000-0000-4000-8000-000000000001', 'CZE'),
        ('00000000-0000-4000-8000-000000000002', 'POL'),
        ('00000000-0000-4000-8000-000000000003', 'CZE');
    `);
    const migration = (await Bun.file(MIGRATION).text()).replaceAll(
      STATEMENT_BREAKPOINT,
      "",
    );
    await client.exec(migration);

    await client.exec(`
      INSERT INTO case_law_decisions (id, country) VALUES
        ('00000000-0000-4000-8000-000000000004', 'SVK'),
        ('00000000-0000-4000-8000-000000000005', 'EU');
      UPDATE case_law_decisions
      SET country = 'AUT'
      WHERE id = '00000000-0000-4000-8000-000000000005';
      DELETE FROM case_law_decisions;
    `);

    const db = drizzle({ client });
    const handle = async (callback: (tx: Transaction) => Promise<unknown>) =>
      // SAFETY: PGlite's Drizzle handle supplies the read-only transaction
      // surface used by listCaseLawJurisdictions.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded database stands in for the scoped handle
      await callback(db as unknown as Transaction);
    // SAFETY: ScopedDb is a brand over the callback shape above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only scoped handle
    const scopedDb = handle as unknown as ScopedDb;

    expect(await listCaseLawJurisdictions(scopedDb)).toEqual([
      "AUT",
      "CZE",
      "EU",
      "POL",
      "SVK",
    ]);

    const overflowJurisdictions = Array.from({ length: 257 }, (_, index) => {
      const first = Math.floor(index / (26 * 26));
      const second = Math.floor(index / 26) % 26;
      const third = index % 26;
      return String.fromCharCode(65 + first, 65 + second, 65 + third);
    });
    await db
      .insert(caseLawCorpusJurisdictions)
      .values(overflowJurisdictions.map((country) => ({ country })))
      .onConflictDoNothing();

    expect(listCaseLawJurisdictions(scopedDb)).rejects.toThrow(
      "exceeds the 256 jurisdiction census ceiling",
    );
  } finally {
    await client.close();
  }
});
