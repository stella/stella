import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api-postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ScopedDb } from "@/api/db";
import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { processLegislationDocument } from "@/api/handlers/legislation/ingestion";
import { createSafeId } from "@/api/lib/branded-types";

// Validates the legislation ingestion entry: store + upsert + source-hash
// dedup. CORPUS_STORAGE_ENABLED is off in tests, so no S3 is touched.

const allSchema = { ...schema, ...authSchema, ...rlsExports };

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const sourceId = createSafeId<"legislationSource">();

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client });
  await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
  await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
  const { sqlStatements } = await pushSchema(allSchema, db);
  for (const statement of sqlStatements) {
    await db.execute(sql.raw(statement));
  }

  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "test",
    name: "Test legislation source",
  });

  // Test shim: run each scopedDb callback directly against the pglite db.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test-only ScopedDb shim
  scopedDb = ((fn: (tx: unknown) => unknown) => fn(db)) as unknown as ScopedDb;
});

afterAll(async () => {
  await client.close();
});

const docInput = (fulltext: string) => ({
  sourceId,
  eli: "SK/2020/40",
  title: "Civil Code",
  country: "SVK",
  language: "sk",
  documentType: "act",
  status: "current" as const,
  effectiveDate: "2020-01-01",
  fulltext,
});

test("ingesting a legislation document inserts a row with its fields", async () => {
  const result = await processLegislationDocument(
    docInput("the obligations of the parties"),
    scopedDb,
  );
  expect(result.inserted).toBe(true);
  expect(result.skipped).toBe(false);

  const [row] = await db
    .select({
      eli: legislationDocuments.eli,
      status: legislationDocuments.status,
      country: legislationDocuments.country,
      sourceHash: legislationDocuments.sourceHash,
    })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, result.id));
  expect(row?.eli).toBe("SK/2020/40");
  expect(row?.status).toBe("current");
  expect(row?.country).toBe("SVK");
  expect(row?.sourceHash).toBeTruthy();
});

test("re-ingesting identical content is skipped (source-hash dedup)", async () => {
  const first = await processLegislationDocument(
    docInput("a stable consolidated text"),
    scopedDb,
  );
  const again = await processLegislationDocument(
    docInput("a stable consolidated text"),
    scopedDb,
  );
  expect(again.id).toBe(first.id);
  expect(again.skipped).toBe(true);
  expect(again.inserted).toBe(false);
});

test("changed content updates the same row (new consolidation text)", async () => {
  const first = await processLegislationDocument(
    docInput("original wording"),
    scopedDb,
  );
  const updated = await processLegislationDocument(
    docInput("amended wording"),
    scopedDb,
  );
  expect(updated.id).toBe(first.id);
  expect(updated.skipped).toBe(false);
  expect(updated.inserted).toBe(false);
});

test("metadata-only change updates the row (same text, new status)", async () => {
  const first = await processLegislationDocument(
    docInput("text that does not change"),
    scopedDb,
  );
  const updated = await processLegislationDocument(
    {
      ...docInput("text that does not change"),
      status: "repealed",
      versionValidTo: "2026-01-01",
    },
    scopedDb,
  );
  expect(updated.id).toBe(first.id);
  expect(updated.skipped).toBe(false);
  expect(updated.inserted).toBe(false);

  const [row] = await db
    .select({
      status: legislationDocuments.status,
      versionValidTo: legislationDocuments.versionValidTo,
      indexedHash: legislationDocuments.indexedHash,
    })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, first.id));
  expect(row?.status).toBe("repealed");
  expect(row?.versionValidTo).toBe("2026-01-01");
  expect(row?.indexedHash).toBeNull();
});
