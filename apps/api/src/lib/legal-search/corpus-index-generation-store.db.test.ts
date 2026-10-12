import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import { CORPUS_FAMILIES } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  type CorpusIndexGenerationTarget,
  CorpusServingGenerationAbsentError,
  lockCorpusIndexGenerationActivationTx,
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
  generation: "case_law_v6",
} as const;
/** What case law serves before it flips to `CASE_LAW_TARGET`. */
const CASE_LAW_PREVIOUS_TARGET = {
  family: "case_law",
  generation: "case_law_v5",
} as const;
const LEGISLATION_TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const register = async (target: CorpusIndexGenerationTarget) =>
  await db.transaction(
    async (tx) =>
      await registerCorpusIndexGenerationTx(asTestRaw<Transaction>(tx), target),
  );

const setServing = async (target: CorpusIndexGenerationTarget) =>
  await db.transaction(
    async (tx) =>
      await setServingCorpusIndexGenerationTx(
        asTestRaw<Transaction>(tx),
        target,
      ),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

test("the ingestion role can fence every corpus source family", async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    for (const family of CORPUS_FAMILIES) {
      await lockCorpusIndexGenerationActivationTx(
        asTestRaw<Transaction>(tx),
        family,
      );
    }
  });
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

  // The drifted row is the whole subject of this test; leaving it registered
  // would fail every later registration of the same generation.
  await db
    .delete(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, LEGISLATION_TARGET.family),
        eq(corpusIndexGenerations.generation, LEGISLATION_TARGET.generation),
      ),
    );
});

test("a family nothing has been promoted in reads as absent, not as a defect", async () => {
  for (const family of CORPUS_FAMILIES) {
    const read = await readServingCorpusIndexGenerationTx(
      asTestRaw<Transaction>(db),
      family,
    );
    expect(Result.isError(read) ? read.error : null).toBeInstanceOf(
      CorpusServingGenerationAbsentError,
    );
  }
});

test("two serving generations of one family break the activation invariant", async () => {
  // The serving index admits one row per family, so the broken state is
  // reachable only with it dropped; the panic rolls the drop back.
  const rejection: unknown = await db
    .transaction(async (tx) => {
      await registerCorpusIndexGenerationTx(
        asTestRaw<Transaction>(tx),
        CASE_LAW_TARGET,
      );
      await registerCorpusIndexGenerationTx(
        asTestRaw<Transaction>(tx),
        CASE_LAW_PREVIOUS_TARGET,
      );
      await tx.execute(
        sql`DROP INDEX corpus_index_generations_serving_family_uidx`,
      );
      await tx
        .update(corpusIndexGenerations)
        .set({ status: "serving" })
        .where(eq(corpusIndexGenerations.family, "case_law"));
      return await readServingCorpusIndexGenerationTx(
        asTestRaw<Transaction>(tx),
        "case_law",
      );
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toMatchObject({
    message: "Expected one serving corpus generation: case_law",
  });
});

test("serving generation reads and flips are family-independent", async () => {
  await register(CASE_LAW_TARGET);
  await register(CASE_LAW_PREVIOUS_TARGET);
  await register(LEGISLATION_TARGET);
  await setServing(CASE_LAW_PREVIOUS_TARGET);
  await setServing(LEGISLATION_TARGET);

  expect(
    await readServingCorpusIndexGenerationTx(
      asTestRaw<Transaction>(db),
      "case_law",
    ),
  ).toEqual(
    Result.ok({
      ...CASE_LAW_PREVIOUS_TARGET,
      cluster: "q09",
    }),
  );

  expect(await setServing(CASE_LAW_TARGET)).toEqual({
    ...CASE_LAW_TARGET,
    cluster: "q09",
  });
  const immediateRollbackRejection: unknown = await setServing(
    CASE_LAW_PREVIOUS_TARGET,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(immediateRollbackRejection).toMatchObject({
    message: `Corpus serving target is not reconciled: case_law/${CASE_LAW_PREVIOUS_TARGET.generation}`,
  });

  await db.transaction(
    async (tx) =>
      await resumeRetiringCorpusIndexGenerationTx(
        asTestRaw<Transaction>(tx),
        CASE_LAW_PREVIOUS_TARGET,
      ),
  );
  expect(await setServing(CASE_LAW_PREVIOUS_TARGET)).toEqual({
    ...CASE_LAW_PREVIOUS_TARGET,
    cluster: "q09",
  });
  expect(
    await readServingCorpusIndexGenerationTx(
      asTestRaw<Transaction>(db),
      "legislation",
    ),
  ).toEqual(
    Result.ok({
      ...LEGISLATION_TARGET,
      cluster: "q09",
    }),
  );
});
