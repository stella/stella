import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getViewConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import { publishedCaseLawDecisions } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  decisionPayloadKey,
  readDecisionVersionedPayload,
} from "@/api/lib/case-law/decision-versioned-payload";
import { pgTimestampCursorValue } from "@/api/lib/db-pagination";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

test("stored decision versions retain microseconds across payload reads and same-millisecond updates", async () => {
  const client = await PGlite.create();
  const db = drizzle({ client });
  try {
    const columns = [
      publishedCaseLawDecisions.id,
      publishedCaseLawDecisions.updatedAt,
      publishedCaseLawDecisions.contentHash,
      publishedCaseLawDecisions.astS3Key,
      publishedCaseLawDecisions.fulltext,
    ];
    const definition = sql.join(
      columns.map(
        (column) =>
          sql`${sql.identifier(column.name)} ${sql.raw(column.getSQLType())}`,
      ),
      sql`, `,
    );
    await db.execute(
      sql`CREATE TABLE ${sql.identifier(getViewConfig(publishedCaseLawDecisions).name)} (${definition})`,
    );
    const id = createSafeId<"caseLawDecision">();
    await db.execute(sql`INSERT INTO case_law_published_decisions
      (id, updated_at, fulltext) VALUES
      (${id}, '2026-01-01T00:00:00.123456Z'::timestamptz, 'first')`);
    const readVersion = async () =>
      (
        await db
          .select({
            id: publishedCaseLawDecisions.id,
            updatedAt: publishedCaseLawDecisions.updatedAt,
            versionTimestamp: pgTimestampCursorValue(
              publishedCaseLawDecisions.updatedAt,
            ),
            contentHash: publishedCaseLawDecisions.contentHash,
            astS3Key: publishedCaseLawDecisions.astS3Key,
          })
          .from(publishedCaseLawDecisions)
      ).at(0);
    const first = await readVersion();
    if (first === undefined) {
      throw new TypeError("Missing first version fixture");
    }
    expect(first.versionTimestamp).toBe("2026-01-01T00:00:00.123456Z");
    const tx = asTestRaw<CaseLawPublicReadTransaction>(db);
    expect(await readDecisionVersionedPayload(tx, first, "fulltext")).toEqual({
      kind: "found",
      value: "first",
    });
    await db.execute(sql`UPDATE case_law_published_decisions
      SET updated_at = '2026-01-01T00:00:00.123457Z'::timestamptz, fulltext = 'second'
      WHERE id = ${id}`);
    const second = await readVersion();
    if (second === undefined) {
      throw new TypeError("Missing second version fixture");
    }
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    expect(second.versionTimestamp).not.toBe(first.versionTimestamp);
    expect(decisionPayloadKey(second)).not.toBe(decisionPayloadKey(first));
    expect(await readDecisionVersionedPayload(tx, first, "fulltext")).toEqual({
      kind: "version-changed",
    });
    expect(await readDecisionVersionedPayload(tx, second, "fulltext")).toEqual({
      kind: "found",
      value: "second",
    });
  } finally {
    await client.close();
  }
});
