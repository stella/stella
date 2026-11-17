/**
 * Retiring a corpus generation against real PostgreSQL with every migration
 * trigger in place: a canonical writer inside the projection fence holds the
 * retire back (it refuses busy rather than waits, then retires once the
 * writer committed), no write reaches the retired generation afterwards,
 * the registry keeps it retired with an immutable receipt, and its whole
 * history, an unfinished revision included, deletes page by page.
 *
 * The suite registers a generation, so it runs alone on a fresh clone
 * (`EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS`).
 */

import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { retireCorpusIndexGeneration } from "@/api/lib/legal-search/corpus-index-generation-retire";
import { purgeRetiredCorpusIndexGenerationPageTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { advanceCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A declared generation no other gated suite registers. */
const TARGET = { family: "case_law", generation: "case_law_v9" } as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v9;
const RECEIPT = { actor: "operator:test", reason: "never serves" } as const;

type Fixture = {
  writerDb: GatedTestDb;
  retireDb: GatedTestDb;
  subject: { family: "case_law"; entityId: SafeId<"caseLawDecision"> };
};

const errorChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

const failureOf = async (work: () => Promise<unknown>): Promise<string> => {
  const outcome = await Result.tryPromise({
    try: work,
    catch: (cause) => cause,
  });
  return outcome.isErr() ? errorChain(outcome.error) : "none";
};

const retireOn = async (db: GatedTestDb) => {
  const outcome = await retireCorpusIndexGeneration(
    async (work) =>
      await db.transaction(
        async (tx) => await work(asTestRaw<Transaction>(tx)),
      ),
    TARGET,
    RECEIPT,
  );
  return outcome.isErr()
    ? `${outcome.error.refusal.class}:${outcome.error.refusal.reason}`
    : outcome.value.type;
};

const canonicalWrite = async (db: GatedTestDb, subject: Fixture["subject"]) =>
  await db.transaction(async (raw) => {
    const tx = asTestRaw<Transaction>(raw);
    await tx
      .update(caseLawDecisions)
      .set({ court: sql`${caseLawDecisions.court} || '.'` })
      .where(eq(caseLawDecisions.id, subject.entityId));
    return await advanceCorpusProjectionDesiredStateTx(tx, subject);
  });

const target = and(
  eq(corpusIndexGenerations.family, TARGET.family),
  eq(corpusIndexGenerations.generation, TARGET.generation),
);

const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL is required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db: writerDb } = openClient();
    const { db: retireDb } = openClient();
    const suffix = Bun.randomUUIDv7();
    const sourceId = toSafeId<"caseLawSource">(Bun.randomUUIDv7());
    const decisionId = toSafeId<"caseLawDecision">(Bun.randomUUIDv7());
    try {
      expect(
        await writerDb
          .select({ generation: corpusIndexGenerations.generation })
          .from(corpusIndexGenerations)
          .where(target),
      ).toEqual([]);
      await writerDb.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `generation-retire-${suffix}`,
        name: "Generation retire",
      });
      await writerDb.insert(caseLawDecisions).values({
        id: decisionId,
        sourceId,
        caseNumber: `generation-retire-${suffix}`,
        court: "Generation retire court",
        country: "CZE",
        language: "cs",
        contentHash: "a".repeat(64),
      });
      await writerDb.insert(corpusIndexGenerations).values({
        ...TARGET,
        cluster: MANIFEST.cluster,
        manifestDigest: corpusIndexManifestDigest(MANIFEST),
        status: "building",
      });
      await run({
        writerDb,
        retireDb,
        subject: { family: "case_law", entityId: decisionId },
      });
    } finally {
      // Retired history may go whole; then the registration itself.
      await writerDb
        .update(corpusIndexGenerations)
        .set({ status: "retired" })
        .where(and(target, eq(corpusIndexGenerations.status, "building")));
      for (;;) {
        const page = await writerDb.transaction(
          async (tx) =>
            await purgeRetiredCorpusIndexGenerationPageTx(
              asTestRaw<Transaction>(tx),
              TARGET,
              { after: null, limit: 1000 },
            ),
        );
        if (page.last === null) {
          break;
        }
      }
      await writerDb.delete(corpusIndexGenerations).where(target);
      await writerDb
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      await writerDb
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, sourceId));
    }
  });
};

const stateOf = async (db: GatedTestDb, entityId: string) =>
  (
    await db
      .select()
      .from(corpusIndexProjectionStates)
      .where(
        and(
          eq(corpusIndexProjectionStates.generation, TARGET.generation),
          eq(corpusIndexProjectionStates.entityId, entityId),
        ),
      )
  ).at(0);

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus generation retire (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus generation retire (postgres)", () => {
    test("a writer inside the projection fence holds the retire back; once it committed the retire lands and no later write reaches the generation", async () => {
      await withFixture(async ({ writerDb, retireDb, subject }) => {
        const writerWrote = Promise.withResolvers<undefined>();
        const releaseWriter = Promise.withResolvers<undefined>();
        const writer = writerDb.transaction(async (raw) => {
          const tx = asTestRaw<Transaction>(raw);
          await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
          await tx
            .update(caseLawDecisions)
            .set({ court: sql`${caseLawDecisions.court} || '.'` })
            .where(eq(caseLawDecisions.id, subject.entityId));
          const advanced = await advanceCorpusProjectionDesiredStateTx(
            tx,
            subject,
          );
          expect(advanced.generationCount).toBe(1);
          writerWrote.resolve(undefined);
          await releaseWriter.promise;
          return advanced;
        });
        await writerWrote.promise;
        // The writer is released only after the retire returns, so a retire
        // that waited for it would never return: the refusal is the proof.
        // Released whatever happens, so the fixture's cleanup is never held.
        const whileWriterHolds = await Result.tryPromise({
          try: async () => await retireOn(retireDb),
          catch: (cause) => cause,
        });
        releaseWriter.resolve(undefined);
        const { epoch } = await writer;
        expect(whileWriterHolds.unwrap()).toBe("busy:lock_unavailable");
        expect((await stateOf(writerDb, subject.entityId))?.desiredEpoch).toBe(
          epoch,
        );

        expect(await retireOn(retireDb)).toBe("retired");
        const held = await stateOf(writerDb, subject.entityId);
        // The writer finds nothing left to project, and a direct write is
        // refused by the database itself.
        expect((await canonicalWrite(writerDb, subject)).generationCount).toBe(
          0,
        );
        expect(
          await failureOf(
            async () =>
              await writerDb
                .update(corpusIndexProjectionStates)
                .set({ retryNotBefore: new Date("2099-01-01T00:00:00.000Z") })
                .where(
                  eq(corpusIndexProjectionStates.generation, TARGET.generation),
                ),
          ),
        ).toContain("is retired and takes no projection writes");
        expect(await stateOf(writerDb, subject.entityId)).toEqual(held);
      });
    });

    test("the registry keeps a retired generation retired with its receipt, and its whole history deletes, an unfinished revision included", async () => {
      await withFixture(async ({ writerDb, retireDb, subject }) => {
        await canonicalWrite(writerDb, subject);
        const state =
          (await stateOf(writerDb, subject.entityId)) ??
          panic("the writer gave the generation no state");
        // A revision a runner reserved and abandoned: its lease ran out.
        await writerDb.insert(corpusIndexProjectionIntents).values({
          id: toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7()),
          family: TARGET.family,
          generation: TARGET.generation,
          entityId: subject.entityId,
          epoch: state.desiredEpoch,
          fingerprint: state.desiredFingerprint ?? panic("no fingerprint"),
          indexId: state.desiredIndexId ?? panic("no index"),
          status: "reserved",
          leaseToken: Bun.randomUUIDv7(),
          leaseExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
        });

        expect(await retireOn(retireDb)).toBe("retired");
        expect(
          await failureOf(
            async () =>
              await writerDb
                .update(corpusIndexGenerations)
                .set({ status: "building" })
                .where(target),
          ),
        ).toContain("retired corpus index generation is terminal");
        expect(
          await failureOf(
            async () =>
              await writerDb
                .update(corpusIndexGenerations)
                .set({ retireActor: "someone:else" })
                .where(target),
          ),
        ).toContain("retire receipt is immutable");
        expect(
          (
            await writerDb
              .select({
                status: corpusIndexGenerations.status,
                retireActor: corpusIndexGenerations.retireActor,
              })
              .from(corpusIndexGenerations)
              .where(target)
          ).at(0),
        ).toEqual({ status: "retired", retireActor: RECEIPT.actor });

        const page = await writerDb.transaction(
          async (tx) =>
            await purgeRetiredCorpusIndexGenerationPageTx(
              asTestRaw<Transaction>(tx),
              TARGET,
              { after: null, limit: 1 },
            ),
        );
        expect(page).toEqual({
          deletedStates: 1,
          deletedIntents: 1,
          last: subject.entityId,
        });
        expect(await stateOf(writerDb, subject.entityId)).toBeUndefined();
      });
    });
  });
}
