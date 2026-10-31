import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";

import { STATUTE_VERSION_CHANGES_METHOD } from "@stll/api-contract/statute-version-changes";

import type { Transaction } from "@/api/db/root";
import {
  legislationDocuments,
  legislationSources,
  systemAuditRuns,
} from "@/api/db/schema";
import { declareWriterContract } from "@/api/handlers/legislation/ingestion";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { writePreparedVersionChangesTx } from "@/api/lib/legal-search/legislation-version-changes";
import type { PreparedVersionChange } from "@/api/lib/legal-search/legislation-version-changes";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "legislation version change writer (postgres)",
  () => {
    const withFixture = async (
      run: (
        db: GatedTestDb,
        sourceId: SafeId<"legislationSource">,
        clients: GatedTestClientScope,
      ) => Promise<void>,
    ) =>
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const { db } = openClient();
          const sourceId = createSafeId<"legislationSource">();
          const ids = [
            createSafeId<"legislationDocument">(),
            createSafeId<"legislationDocument">(),
            createSafeId<"legislationDocument">(),
          ];
          await db.insert(legislationSources).values({
            id: sourceId,
            adapterKey: `version-change-writer-${sourceId}`,
            name: "Version change writer test",
          });
          try {
            await db.insert(legislationDocuments).values(
              ids.map((id, index) => ({
                id,
                sourceId,
                eli: `eli/cz/version-change-writer-${sourceId}`,
                title: "Test legislation",
                country: "CZE",
                language: "cs",
                versionValidFrom: `202${index}-01-01`,
              })),
            );
            return await run(db, sourceId, { openClient });
          } finally {
            await db
              .delete(legislationSources)
              .where(eq(legislationSources.id, sourceId));
          }
        },
      );

    const prepared = (
      targetId: SafeId<"legislationDocument">,
      sourceId: SafeId<"legislationSource">,
      base: PreparedVersionChange["base"] = null,
    ): PreparedVersionChange => {
      const provenance = {
        method: STATUTE_VERSION_CHANGES_METHOD,
        payloadRevision: 1,
      };
      return {
        targetId,
        base,
        work: {
          sourceId,
          eli: `eli/cz/version-change-writer-${sourceId}`,
          language: "cs",
        },
        summary:
          base === null
            ? { type: "first", ...provenance }
            : {
                type: "compared",
                ...provenance,
                base: {
                  documentId: base.id,
                  payloadRevision: Number(base.payloadRevision),
                },
                counts: {
                  provisions: { changed: 0, added: 0, removed: 0 },
                  words: { inserted: 0, deleted: 0 },
                },
              },
      };
    };

    const ownAudits = async (tx: Transaction) =>
      await tx
        .select({ counts: systemAuditRuns.counts })
        .from(systemAuditRuns)
        .where(
          sql`${systemAuditRuns.actor} = 'system:legislation-version-changes' AND xmin = pg_current_xact_id()::text::xid`,
        )
        .limit(2);

    const writeInTransaction = async (
      tx: Transaction,
      writes: readonly PreparedVersionChange[],
    ) => {
      await declareWriterContract(tx);
      return await writePreparedVersionChangesTx(tx, writes);
    };

    test("waits for base locks and refuses a summary after the base payload changes", async () => {
      await withFixture(async (db, sourceId, clients) => {
        const [base, target] = await db
          .select({ id: legislationDocuments.id })
          .from(legislationDocuments)
          .where(eq(legislationDocuments.sourceId, sourceId))
          .orderBy(asc(legislationDocuments.versionValidFrom))
          .limit(2);
        if (base === undefined || target === undefined) {
          panic("Fixture documents are missing");
        }
        const lockAcquired = Promise.withResolvers<undefined>();
        const releaseLock = Promise.withResolvers<undefined>();
        const writerDb = clients.openClient().db;
        const holder = db.transaction(async (tx) => {
          await tx
            .select({ id: legislationDocuments.id })
            .from(legislationDocuments)
            .where(eq(legislationDocuments.id, base.id))
            .for("update");
          lockAcquired.resolve(undefined);
          await releaseLock.promise;
          await declareWriterContract(tx);
          await tx
            .update(legislationDocuments)
            .set({ fulltext: "updated base payload" })
            .where(eq(legislationDocuments.id, base.id));
        });
        await lockAcquired.promise;
        try {
          const outcome = await writerDb
            .transaction(async (tx) => {
              await tx.execute(sql`SET LOCAL lock_timeout = '50ms'`);
              return await writeInTransaction(tx, [
                prepared(target.id, sourceId, {
                  id: base.id,
                  payloadRevision: 1n,
                }),
              ]);
            })
            .then(
              (written) => ({ type: "written" as const, written }),
              (error: unknown) => ({ type: "locked" as const, error }),
            );
          expect(outcome.type).toBe("locked");
          if (outcome.type === "locked") {
            const messages: string[] = [];
            let cause: unknown = outcome.error;
            while (cause instanceof Error) {
              messages.push(cause.message);
              cause = cause.cause;
            }
            expect(messages.join(" ")).toMatch(/lock timeout|55P03/iu);
          }
          releaseLock.resolve(undefined);
          await holder;
          const stale = await writerDb.transaction(async (tx) => ({
            written: await writeInTransaction(tx, [
              prepared(target.id, sourceId, {
                id: base.id,
                payloadRevision: 1n,
              }),
            ]),
            audits: await ownAudits(tx),
          }));
          expect(stale.written).toBe(0);
          expect(stale.audits).toEqual([]);
        } finally {
          releaseLock.resolve(undefined);
          await holder;
        }
      });
    });

    test("serializes reverse-order replays and audits only unique summary writes", async () => {
      await withFixture(async (db, sourceId, clients) => {
        const rows = await db
          .select({ id: legislationDocuments.id })
          .from(legislationDocuments)
          .where(eq(legislationDocuments.sourceId, sourceId))
          .orderBy(asc(legislationDocuments.versionValidFrom))
          .limit(3);
        const [first, second, third] = rows;
        if (
          first === undefined ||
          second === undefined ||
          third === undefined
        ) {
          panic("Fixture documents are missing");
        }
        const writes = [
          prepared(first.id, sourceId),
          prepared(third.id, sourceId, {
            id: second.id,
            payloadRevision: 1n,
          }),
        ];
        const writerA = clients.openClient().db;
        const writerB = clients.openClient().db;
        const counts = await Promise.all([
          writerA.transaction(async (tx) => ({
            written: await writeInTransaction(tx, writes),
            audits: await ownAudits(tx),
          })),
          writerB.transaction(async (tx) => ({
            written: await writeInTransaction(tx, writes.toReversed()),
            audits: await ownAudits(tx),
          })),
        ]);
        expect(counts.reduce((sum, { written }) => sum + written, 0)).toBe(2);
        expect(counts.map(({ written }) => written).toSorted()).toEqual([0, 2]);
        expect(counts.flatMap(({ audits }) => audits)).toEqual([
          { counts: { summaries: 2 } },
        ]);
        const replay = await writerA.transaction(async (tx) => ({
          written: await writeInTransaction(tx, writes),
          audits: await ownAudits(tx),
        }));
        expect(replay).toEqual({ written: 0, audits: [] });
      });
    });
  },
);
