/**
 * The serving flip against real PostgreSQL locks: a canonical writer holding
 * its source lock must hold back the flip before the flip takes any registry
 * row lock, so the writer's later key-share lock on the generation row (the
 * projection foreign keys take it) cannot close a deadlock cycle.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { lockActiveCorpusProjectionSourceTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  lockCorpusIndexProjectionWriterTx,
  readCorpusIndexProjectionRevisionTx,
} from "@/api/lib/legal-search/corpus-index-projection-revision";
import { isRecord } from "@/api/lib/type-guards";
import { applyServeTx } from "@/api/scripts/corpus-generation";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A manifest generation no other gated suite registers. */
const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v7;
const TARGET = { family: "case_law", generation: "case_law_v7" } as const;
const LOCK_WAIT_POLL_MS = 20;
const LOCK_WAIT_ATTEMPTS = 100;

type RelationLock = { relation: string; mode: string; granted: boolean };

const relationLocksOf = async (
  db: GatedTestDb,
  pid: number,
): Promise<RelationLock[]> =>
  executedRows(
    await db.execute(sql`
      SELECT relation::regclass::text AS relation, mode, granted
      FROM pg_catalog.pg_locks
      WHERE pid = ${pid} AND locktype = 'relation'
    `),
  ).map((row) =>
    isRecord(row) &&
    typeof row["relation"] === "string" &&
    typeof row["mode"] === "string" &&
    typeof row["granted"] === "boolean"
      ? {
          relation: row["relation"],
          mode: row["mode"],
          granted: row["granted"],
        }
      : panic("pg_locks returned a malformed row"),
  );

/** Resolves with the backend's locks once it waits on `relation`. */
const waitingOn = async (
  db: GatedTestDb,
  pid: number,
  relation: string,
): Promise<RelationLock[]> => {
  for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
    const locks = await relationLocksOf(db, pid);
    if (locks.some((lock) => lock.relation === relation && !lock.granted)) {
      return locks;
    }
    await Bun.sleep(LOCK_WAIT_POLL_MS);
  }
  return panic(`backend ${String(pid)} never waited on ${relation}`);
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus serving flip lock order (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus serving flip lock order (postgres)", () => {
    test("a canonical writer holds back the flip before any registry row lock, and both commit", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: writerDb } = openClient();
        const { db: serveDb } = openClient();
        const { db: observerDb } = openClient();
        const suffix = Date.now();
        const sourceId = toSafeId<"caseLawSource">(Bun.randomUUIDv7());
        const decisionId = toSafeId<"caseLawDecision">(Bun.randomUUIDv7());
        const subject = { family: "case_law", entityId: decisionId } as const;
        const writerLocked = Promise.withResolvers<undefined>();
        const releaseWriter = Promise.withResolvers<undefined>();
        const servePid = Promise.withResolvers<number>();
        let previouslyServing: string | null = null;

        try {
          const familyRows = await writerDb
            .select({
              generation: corpusIndexGenerations.generation,
              status: corpusIndexGenerations.status,
            })
            .from(corpusIndexGenerations)
            .where(eq(corpusIndexGenerations.family, TARGET.family));
          expect(
            familyRows.some(
              ({ generation }) => generation === TARGET.generation,
            ),
          ).toBe(false);
          previouslyServing =
            familyRows.find(({ status }) => status === "serving")?.generation ??
            null;

          await writerDb.insert(caseLawSources).values({
            id: sourceId,
            adapterKey: `serving-flip-lock-order-${suffix}`,
            name: "Serving flip lock order",
          });
          await writerDb.insert(caseLawDecisions).values({
            id: decisionId,
            sourceId,
            caseNumber: `serving-flip-lock-order-${suffix}`,
            court: "Serving flip court",
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
          const revision = await writerDb.transaction(
            async (tx) => await readCorpusIndexProjectionRevisionTx(tx, TARGET),
          );

          // The canonical order: source share lock, the shared side of the
          // projection fence, then a key-share lock on the generation row.
          const writer = writerDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            expect(
              await lockActiveCorpusProjectionSourceTx(tx, subject),
            ).not.toBeNull();
            writerLocked.resolve(undefined);
            await releaseWriter.promise;
            await lockCorpusIndexProjectionWriterTx(tx);
            await tx
              .select({ generation: corpusIndexGenerations.generation })
              .from(corpusIndexGenerations)
              .where(
                and(
                  eq(corpusIndexGenerations.family, TARGET.family),
                  eq(corpusIndexGenerations.generation, TARGET.generation),
                ),
              )
              .for("key share");
          });
          await writerLocked.promise;

          const serve = serveDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            const pid = executedRows(
              await tx.execute(sql`SELECT pg_backend_pid() AS pid`),
            ).at(0);
            servePid.resolve(
              isRecord(pid) && typeof pid["pid"] === "number"
                ? pid["pid"]
                : panic("pg_backend_pid returned a malformed row"),
            );
            return await applyServeTx(
              tx,
              {
                ...TARGET,
                manifest: MANIFEST,
                manifestDigest: corpusIndexManifestDigest(MANIFEST),
              },
              { revision, convergence: "ready_for_census" },
            );
          });

          const locks = await waitingOn(
            observerDb,
            await servePid.promise,
            "case_law_sources",
          );
          expect(locks).toContainEqual({
            relation: "case_law_sources",
            mode: "ExclusiveLock",
            granted: false,
          });
          // A registry row lock shows as a relation lock on the registry.
          expect(
            locks.filter(
              ({ relation }) => relation === "corpus_index_generations",
            ),
          ).toEqual([]);

          releaseWriter.resolve(undefined);
          await writer;
          const flipped = await serve;
          expect(flipped.isOk()).toBe(true);
          expect(flipped.isOk() ? flipped.value.type : null).toBe("promote");
          const rows = await writerDb
            .select({ status: corpusIndexGenerations.status })
            .from(corpusIndexGenerations)
            .where(
              and(
                eq(corpusIndexGenerations.family, TARGET.family),
                eq(corpusIndexGenerations.generation, TARGET.generation),
              ),
            );
          expect(rows.at(0)?.status).toBe("serving");
        } finally {
          releaseWriter.resolve(undefined);
          const target = and(
            eq(corpusIndexGenerations.family, TARGET.family),
            eq(corpusIndexGenerations.generation, TARGET.generation),
          );
          await writerDb
            .update(corpusIndexGenerations)
            .set({ status: "retired" })
            .where(target);
          await writerDb.delete(corpusIndexGenerations).where(target);
          if (previouslyServing !== null) {
            await writerDb
              .update(corpusIndexGenerations)
              .set({ status: "serving" })
              .where(
                and(
                  eq(corpusIndexGenerations.family, TARGET.family),
                  eq(corpusIndexGenerations.generation, previouslyServing),
                ),
              );
          }
          await writerDb
            .delete(caseLawDecisions)
            .where(eq(caseLawDecisions.id, decisionId));
          await writerDb
            .delete(caseLawSources)
            .where(eq(caseLawSources.id, sourceId));
        }
      });
    });
  });
}
