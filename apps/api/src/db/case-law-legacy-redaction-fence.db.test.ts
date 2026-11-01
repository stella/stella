import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { installPgliteCaseLawLegacyRedactionFence } from "@/api/tests/pglite-schema";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const CONTENT_HASH = "a".repeat(64);

const insertDecision = async (
  values: Partial<typeof caseLawDecisions.$inferInsert>,
) => {
  const id = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id,
    sourceId,
    // UUIDv7 ids share their time prefix; the random tail keeps marks unique.
    caseNumber: `I. ÚS ${id.slice(-12)}/24`,
    court: "Ústavní soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2024-01-01",
    slug: `fence-${id}`,
    languageGroupKey: `fence-${id}`,
    ...values,
  });
  return id;
};

const readRedaction = async (id: SafeId<"caseLawDecision">) => {
  const [row] = await db
    .select({
      redacted: caseLawDecisions.redactedAt,
      sourceRaw: caseLawDecisions.sourceRaw,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  return { redacted: row?.redacted !== null, sourceRaw: row?.sourceRaw };
};

// timeout: Boot the shared PGlite engine and complete schema before assertions.
beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    // Production has carried this fence since its first migration; the shared
    // schema leaves it out, so this suite installs the current definition.
    await installPgliteCaseLawLegacyRedactionFence(db);
    await db
      .insert(caseLawSources)
      .values({ id: sourceId, adapterKey: ADAPTER_KEYS.CZ_US, name: "fence" });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("moving inline raw source to object storage does not redact a row without a parsed payload", async () => {
  const id = await insertDecision({ sourceRaw: "<html>listing</html>" });

  await db
    .update(caseLawDecisions)
    .set({ sourceRaw: null })
    .where(eq(caseLawDecisions.id, id));

  expect(await readRedaction(id)).toEqual({ redacted: false, sourceRaw: null });
});

test("a legacy payload clear redacts the row and erases its inline raw source", async () => {
  const id = await insertDecision({
    fulltext: "Odůvodnění.",
    contentHash: CONTENT_HASH,
    sourceRaw: "<html>decision</html>",
  });

  await db
    .update(caseLawDecisions)
    .set({ fulltext: null, contentHash: null })
    .where(eq(caseLawDecisions.id, id));

  expect(await readRedaction(id)).toEqual({ redacted: true, sourceRaw: null });
});
