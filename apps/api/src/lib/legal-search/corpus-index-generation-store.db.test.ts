import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import {
  readServingCorpusIndexGenerationTx,
  registerCorpusIndexGenerationTx,
  resumeRetiringCorpusIndexGenerationTx,
  setServingCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const CASE_LAW_TARGET = {
  family: "case_law",
  generation: "case_law_v5",
} as const;
const LEGISLATION_TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const register = async (target: typeof CASE_LAW_TARGET) =>
  await db.transaction(
    async (tx) =>
      await registerCorpusIndexGenerationTx(asTestRaw<Transaction>(tx), target),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

test("generation registration is idempotent and manifest-derived", async () => {
  expect(await register(CASE_LAW_TARGET)).toEqual(
    requireCorpusIndexManifest(
      CASE_LAW_TARGET.family,
      CASE_LAW_TARGET.generation,
    ),
  );
  await register(CASE_LAW_TARGET);

  const rows = await db
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, CASE_LAW_TARGET.family),
        eq(corpusIndexGenerations.generation, CASE_LAW_TARGET.generation),
      ),
    );
  expect(rows).toHaveLength(1);
  expect(rows.at(0)).toMatchObject({
    ...CASE_LAW_TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      requireCorpusIndexManifest(
        CASE_LAW_TARGET.family,
        CASE_LAW_TARGET.generation,
      ),
    ),
    status: "building",
  });
});

test("generation registration fails closed on a drifted binding", async () => {
  await db.insert(corpusIndexGenerations).values({
    ...LEGISLATION_TARGET,
    cluster: "q09",
    manifestDigest: "f".repeat(64),
    status: "building",
  });

  // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
  // type-aware lint; capture the rejection explicitly instead.
  const rejection: unknown = await db
    .transaction(
      async (tx) =>
        await registerCorpusIndexGenerationTx(
          asTestRaw<Transaction>(tx),
          LEGISLATION_TARGET,
        ),
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toMatchObject({
    message: "Corpus generation contract mismatch: legislation/legislation_v2",
  });
});

test("serving generation reads and flips are family-independent", async () => {
  await register(CASE_LAW_TARGET);
  await db.insert(corpusIndexGenerations).values([
    {
      family: "case_law",
      generation: "case_law_v2",
      cluster: "q08",
      manifestDigest: "a".repeat(64),
      status: "serving",
    },
    {
      family: "legislation",
      generation: "legislation_v1",
      cluster: "q08",
      manifestDigest: "b".repeat(64),
      status: "serving",
    },
  ]);

  expect(
    await readServingCorpusIndexGenerationTx(
      asTestRaw<Transaction>(db),
      "case_law",
    ),
  ).toEqual({
    family: "case_law",
    generation: "case_law_v2",
    cluster: "q08",
  });

  const promoted = await db.transaction(
    async (tx) =>
      await setServingCorpusIndexGenerationTx(
        asTestRaw<Transaction>(tx),
        CASE_LAW_TARGET,
      ),
  );
  expect(promoted).toEqual({
    family: "case_law",
    generation: "case_law_v5",
    cluster: "q09",
  });
  const immediateRollbackRejection: unknown = await db
    .transaction(
      async (tx) =>
        await setServingCorpusIndexGenerationTx(asTestRaw<Transaction>(tx), {
          family: "case_law",
          generation: "case_law_v2",
        }),
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(immediateRollbackRejection).toMatchObject({
    message: "Corpus serving target is not reconciled: case_law/case_law_v2",
  });

  await db.transaction(
    async (tx) =>
      await resumeRetiringCorpusIndexGenerationTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v2",
      }),
  );
  expect(
    await db.transaction(
      async (tx) =>
        await setServingCorpusIndexGenerationTx(asTestRaw<Transaction>(tx), {
          family: "case_law",
          generation: "case_law_v2",
        }),
    ),
  ).toEqual({
    family: "case_law",
    generation: "case_law_v2",
    cluster: "q08",
  });
  expect(
    await readServingCorpusIndexGenerationTx(
      asTestRaw<Transaction>(db),
      "legislation",
    ),
  ).toEqual({
    family: "legislation",
    generation: "legislation_v1",
    cluster: "q08",
  });
});
