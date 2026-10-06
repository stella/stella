import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { withDeferredDocumentSourceOwnership } from "@/api/lib/legal-search/deferred-document-source-ownership";
import {
  claimDocumentFetch,
  fetchDecisionDocument,
  markDocumentUnavailable,
  parkDocumentFetch,
  storeBackfilledDocument,
  MAX_DOCUMENT_FETCH_ATTEMPTS,
} from "@/api/lib/legal-search/sk-document-backfill";
import type { BackfilledDocument } from "@/api/lib/legal-search/sk-document-backfill";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { readOfResponse } from "@/api/tests/helpers/publisher-read";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const barrier = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
};

if (!databaseUrl || !enabled) {
  describe.skip("deferred document source ownership", () => {
    test("requires the Postgres test lane", () => {
      expect(enabled && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("deferred document source ownership", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (run) =>
      await db.transaction(async (tx) => await run(tx));
    const sources: SafeId<"caseLawSource">[] = [];
    const decisions: SafeId<"caseLawDecision">[] = [];
    const fixture = async () => {
      const source =
        (
          await db
            .insert(caseLawSources)
            .values({
              adapterKey: `ownership-${Bun.randomUUIDv7()}`,
              name: "Document ownership test",
              enabled: false,
            })
            .returning({ id: caseLawSources.id })
        ).at(0) ?? panic("source fixture missing");
      sources.push(source.id);
      const decision =
        (
          await db
            .insert(caseLawDecisions)
            .values({
              sourceId: source.id,
              caseNumber: "1/2026",
              court: "Court",
              country: "SVK",
              language: "sk",
              fulltext: null,
              documentUrl:
                "https://obcan.justice.sk/content/public/item/document.pdf",
            })
            .returning({ id: caseLawDecisions.id })
        ).at(0) ?? panic("decision fixture missing");
      decisions.push(decision.id);
      return { sourceId: source.id, decisionId: decision.id };
    };
    cleanUp(async () => {
      if (decisions.length > 0) {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, decisions));
      }
      if (sources.length > 0) {
        await db
          .delete(caseLawSources)
          .where(inArray(caseLawSources.id, sources));
      }
    });
    const readDecision = async (decisionId: SafeId<"caseLawDecision">) =>
      (
        await db
          .select({
            fulltext: caseLawDecisions.fulltext,
            documentFetchAttempts: caseLawDecisions.documentFetchAttempts,
            textS3Key: caseLawDecisions.textS3Key,
            normalizedS3Key: caseLawDecisions.normalizedS3Key,
            astS3Key: caseLawDecisions.astS3Key,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, decisionId))
          .limit(1)
      ).at(0);
    const readSource = async (sourceId: SafeId<"caseLawSource">) =>
      await db.query.caseLawSources.findFirst({
        where: { id: { eq: sourceId } },
        columns: {
          ingestionLeaseToken: true,
          decisionMergeEpoch: true,
        },
      });

    test("one decision claim proceeds and another writer preserves its claim", async () => {
      const { sourceId, decisionId } = await fixture();
      const started = barrier();
      const finish = barrier();
      let remoteEffects = 0;
      const first = fetchDecisionDocument({
        decisionId,
        scopedDb,
        signal: new AbortController().signal,
        fetchDocument: async () => {
          remoteEffects += 1;
          started.resolve();
          await finish.promise;
          return readOfResponse(new Response(null, { status: 404 }));
        },
      });
      await started.promise;
      try {
        expect(
          await fetchDecisionDocument({
            decisionId,
            scopedDb,
            signal: new AbortController().signal,
            fetchDocument: async () => {
              remoteEffects += 1;
              return readOfResponse(new Response(null, { status: 404 }));
            },
          }),
        ).toEqual({ status: "claimed" });
        expect(remoteEffects).toBe(1);
        expect((await readDecision(decisionId))?.documentFetchAttempts).toBe(1);
      } finally {
        finish.resolve();
      }
      expect(await first).toEqual({ status: "unavailable" });
      expect((await readSource(sourceId))?.ingestionLeaseToken).toBeNull();
    });

    test("a deferred writer settles while an ingestion lease remains held", async () => {
      const { sourceId, decisionId } = await fixture();
      const crawler = await acquireCaseLawSourceIngestionLease({
        sourceId,
        scopedDb,
        purpose: "ingestion",
      });
      if (crawler === null) {
        panic("crawler fixture ownership missing");
      }
      try {
        expect(
          await fetchDecisionDocument({
            decisionId,
            scopedDb,
            signal: new AbortController().signal,
            fetchDocument: async () =>
              readOfResponse(new Response(null, { status: 404 })),
          }),
        ).toEqual({ status: "unavailable" });
        expect((await readDecision(decisionId))?.fulltext).toBe("");
        expect((await readDecision(decisionId))?.documentFetchAttempts).toBe(1);
        expect((await readSource(sourceId))?.ingestionLeaseToken).toBe(
          crawler.leaseToken,
        );
      } finally {
        await crawler.release();
      }
    });

    for (const purpose of ["ingestion", "decision-merge"] as const) {
      test(`an expired ${purpose} lease permits settlement`, async () => {
        const { sourceId, decisionId } = await fixture();
        await db
          .update(caseLawSources)
          .set({
            ingestionLeaseToken: createSafeId<"caseLawSourceIngestionLease">(),
            ingestionLeasePurpose: purpose,
            ingestionLeaseExpiresAt: new Date("2000-01-01T00:00:00Z"),
          })
          .where(eq(caseLawSources.id, sourceId));
        expect(
          await fetchDecisionDocument({
            decisionId,
            scopedDb,
            signal: new AbortController().signal,
            fetchDocument: async () =>
              readOfResponse(new Response(null, { status: 404 })),
          }),
        ).toEqual({ status: "unavailable" });
      });
    }

    test("a decision merge lease acquired during fetch returns lost without settling or parking", async () => {
      const { sourceId, decisionId } = await fixture();
      await db
        .update(caseLawDecisions)
        .set({ documentFetchAttempts: MAX_DOCUMENT_FETCH_ATTEMPTS - 1 })
        .where(eq(caseLawDecisions.id, decisionId));
      const mergeOwner: {
        lease: Awaited<ReturnType<typeof acquireCaseLawSourceIngestionLease>>;
      } = { lease: null };
      try {
        const outcome = await fetchDecisionDocument({
          decisionId,
          scopedDb,
          signal: new AbortController().signal,
          fetchDocument: async () => {
            mergeOwner.lease = await acquireCaseLawSourceIngestionLease({
              sourceId,
              scopedDb,
              purpose: "decision-merge",
            });
            expect(mergeOwner.lease).not.toBeNull();
            return readOfResponse(new Response(null, { status: 404 }));
          },
        });
        expect(outcome).toEqual({ status: "lost" });
        expect(await readDecision(decisionId)).toEqual({
          fulltext: null,
          documentFetchAttempts: MAX_DOCUMENT_FETCH_ATTEMPTS - 1,
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
        });
      } finally {
        await mergeOwner.lease?.release();
      }
    });

    test("the source row remains locked throughout the decision write transaction", async () => {
      const { sourceId, decisionId } = await fixture();
      const result = await withDeferredDocumentSourceOwnership({
        decisionId,
        scopedDb,
        timeoutMs: 1000,
        operation: async (fence) =>
          await fence.scopedDb(async (tx) => {
            const attempt = await Result.tryPromise({
              try: async () =>
                await db.transaction(
                  async (other) =>
                    await other.execute(
                      sql`SELECT id FROM public.case_law_sources WHERE id = ${sourceId}::uuid FOR UPDATE NOWAIT`,
                    ),
                ),
              catch: (error) => error,
            });
            expect(Result.isError(attempt)).toBe(true);
            if (Result.isOk(attempt)) {
              panic("source row was not locked");
            }
            expect(getPgErrorCode(attempt.error)).toBe(
              PG_ERROR.LOCK_NOT_AVAILABLE,
            );
            await tx
              .update(caseLawDecisions)
              .set({ fulltext: "document" })
              .where(eq(caseLawDecisions.id, decisionId));
          }),
      });
      expect(result.status).toBe("completed");
      expect((await readDecision(decisionId))?.fulltext).toBe("document");
    });

    test("a decision merge fence during settlement rolls back the entire database callback", async () => {
      const { sourceId, decisionId } = await fixture();
      const result = await withDeferredDocumentSourceOwnership({
        decisionId,
        scopedDb,
        timeoutMs: 1000,
        operation: async (fence) =>
          await fence.scopedDb(async (tx) => {
            await tx
              .update(caseLawSources)
              .set({
                ingestionLeaseToken:
                  createSafeId<"caseLawSourceIngestionLease">(),
                ingestionLeasePurpose: "decision-merge",
                ingestionLeaseExpiresAt: new Date(Date.now() + 60_000),
              })
              .where(eq(caseLawSources.id, sourceId));
            await tx
              .update(caseLawDecisions)
              .set({ fulltext: "document" })
              .where(eq(caseLawDecisions.id, decisionId));
          }),
      });
      expect(result).toEqual({ status: "lost" });
      expect((await readDecision(decisionId))?.fulltext).toBeNull();
      expect((await readSource(sourceId))?.ingestionLeaseToken).toBeNull();
    });

    test("a decision merge that starts and ends during a remote effect blocks settlement", async () => {
      const { sourceId, decisionId } = await fixture();
      const epochBefore = (await readSource(sourceId))?.decisionMergeEpoch;
      const result = await withDeferredDocumentSourceOwnership({
        decisionId,
        scopedDb,
        timeoutMs: 1000,
        operation: async (fence) => {
          await fence.beforeRemoteEffect(async () => {
            const merge = await acquireCaseLawSourceIngestionLease({
              sourceId,
              scopedDb,
              purpose: "decision-merge",
            });
            if (merge === null) {
              panic("decision merge fixture missing");
            }
            await merge.release();
          });
          await fence.scopedDb(async (tx) => {
            await tx
              .update(caseLawDecisions)
              .set({ fulltext: "document" })
              .where(eq(caseLawDecisions.id, decisionId));
          });
        },
      });
      expect(result).toEqual({ status: "lost" });
      expect((await readDecision(decisionId))?.fulltext).toBeNull();
      const source = await readSource(sourceId);
      expect(source?.ingestionLeaseToken).toBeNull();
      if (epochBefore === undefined) {
        panic("source fixture missing");
      }
      expect(source?.decisionMergeEpoch).toBe(epochBefore + 1n);
    });

    test("an ingestion claim does not advance the decision merge epoch", async () => {
      const { sourceId } = await fixture();
      const epochBefore = (await readSource(sourceId))?.decisionMergeEpoch;
      const ingestion = await acquireCaseLawSourceIngestionLease({
        sourceId,
        scopedDb,
      });
      if (ingestion === null) {
        panic("ingestion lease fixture missing");
      }
      await ingestion.release();
      expect((await readSource(sourceId))?.decisionMergeEpoch).toBe(
        epochBefore,
      );
    });

    test("a decision merge completed after a claim refuses every settlement of that claim", async () => {
      const { sourceId, decisionId } = await fixture();
      const claim = await claimDocumentFetch(decisionId, scopedDb);
      if (claim.status !== "claimed") {
        panic("document claim fixture missing");
      }
      const merge = await acquireCaseLawSourceIngestionLease({
        sourceId,
        scopedDb,
        purpose: "decision-merge",
      });
      if (merge === null) {
        panic("decision merge fixture missing");
      }
      await merge.release();
      const document = {
        fulltext: "document",
        sections: [],
        documentAst: {
          version: 1,
          source: {
            system: "fixture",
            documentId: "document",
            webUrl: "",
            printUrl: "",
          },
          metadata: {
            caseNumber: "1/2026",
            ecli: null,
            court: "Court",
            decisionDate: null,
            decisionType: null,
            keywords: [],
            statutes: [],
          },
          blocks: [],
        },
      } satisfies BackfilledDocument;
      for (const result of [
        await markDocumentUnavailable({ decision: claim.decision, scopedDb }),
        await parkDocumentFetch({ decision: claim.decision, scopedDb }),
        await storeBackfilledDocument({
          decision: claim.decision,
          document,
          scopedDb,
          transfer: null,
        }),
      ]) {
        expect(result).toEqual({ status: "lost" });
      }
      expect((await readDecision(decisionId))?.fulltext).toBeNull();
      expect((await readDecision(decisionId))?.documentFetchAttempts).toBe(1);
    });

    test("every exported document mutation observes a decision merge owner", async () => {
      const { sourceId, decisionId } = await fixture();
      const claim = await claimDocumentFetch(decisionId, scopedDb);
      if (claim.status !== "claimed") {
        panic("document claim fixture missing");
      }
      const owner = await acquireCaseLawSourceIngestionLease({
        sourceId,
        scopedDb,
        purpose: "decision-merge",
      });
      if (owner === null) {
        panic("source owner fixture missing");
      }
      try {
        const document = {
          fulltext: "document",
          sections: [],
          documentAst: {
            version: 1,
            source: {
              system: "fixture",
              documentId: "document",
              webUrl: "",
              printUrl: "",
            },
            metadata: {
              caseNumber: "1/2026",
              ecli: null,
              court: "Court",
              decisionDate: null,
              decisionType: null,
              keywords: [],
              statutes: [],
            },
            blocks: [],
          },
        } satisfies BackfilledDocument;
        for (const result of [
          await claimDocumentFetch(decisionId, scopedDb),
          await markDocumentUnavailable({ decision: claim.decision, scopedDb }),
          await parkDocumentFetch({ decision: claim.decision, scopedDb }),
          await storeBackfilledDocument({
            decision: claim.decision,
            document,
            scopedDb,
            transfer: null,
          }),
        ]) {
          expect(result).toEqual({ status: "busy" });
        }
        expect((await readDecision(decisionId))?.fulltext).toBeNull();
        expect((await readDecision(decisionId))?.documentFetchAttempts).toBe(1);
      } finally {
        await owner.release();
      }
    });

    test("same-source deferred writers and another source can proceed", async () => {
      const first = await fixture();
      const otherSource = await fixture();
      const sameSource =
        (
          await db
            .insert(caseLawDecisions)
            .values({
              sourceId: first.sourceId,
              caseNumber: "2/2026",
              court: "Court",
              country: "SVK",
              language: "sk",
              fulltext: null,
            })
            .returning({ id: caseLawDecisions.id })
        ).at(0) ?? panic("second document fixture missing");
      decisions.push(sameSource.id);
      const result = await withDeferredDocumentSourceOwnership({
        decisionId: first.decisionId,
        scopedDb,
        timeoutMs: 1000,
        operation: async () => {
          expect(
            await withDeferredDocumentSourceOwnership({
              decisionId: sameSource.id,
              scopedDb,
              timeoutMs: 1000,
              operation: async () => "document",
            }),
          ).toEqual({ status: "completed", value: "document" });
          expect(
            await withDeferredDocumentSourceOwnership({
              decisionId: otherSource.decisionId,
              scopedDb,
              timeoutMs: 1000,
              operation: async () => "document",
            }),
          ).toEqual({ status: "completed", value: "document" });
        },
      });
      expect(result.status).toBe("completed");
    });

    for (const mutation of ["claim", "unavailable", "park", "store"] as const) {
      test(`${mutation} refuses source ownership lost before its transaction`, async () => {
        const { sourceId, decisionId } = await fixture();
        const claim = await claimDocumentFetch(decisionId, scopedDb);
        if (claim.status !== "claimed") {
          panic("document claim fixture missing");
        }
        let transactions = 0;
        const mergeOwner: {
          lease: Awaited<ReturnType<typeof acquireCaseLawSourceIngestionLease>>;
        } = { lease: null };
        const interruptedDb: ScopedDb = async (run) => {
          transactions += 1;
          if (transactions === 2) {
            mergeOwner.lease = await acquireCaseLawSourceIngestionLease({
              sourceId,
              scopedDb,
              purpose: "decision-merge",
            });
            expect(mergeOwner.lease).not.toBeNull();
          }
          return await scopedDb(run);
        };
        const document = {
          fulltext: "document",
          sections: [],
          documentAst: {
            version: 1,
            source: {
              system: "fixture",
              documentId: "document",
              webUrl: "",
              printUrl: "",
            },
            metadata: {
              caseNumber: "1/2026",
              ecli: null,
              court: "Court",
              decisionDate: null,
              decisionType: null,
              keywords: [],
              statutes: [],
            },
            blocks: [],
          },
        } satisfies BackfilledDocument;
        const mutate = async () => {
          switch (mutation) {
            case "claim":
              return await claimDocumentFetch(decisionId, interruptedDb);
            case "unavailable":
              return await markDocumentUnavailable({
                decision: claim.decision,
                scopedDb: interruptedDb,
              });
            case "park":
              return await parkDocumentFetch({
                decision: claim.decision,
                scopedDb: interruptedDb,
              });
            case "store":
              return await storeBackfilledDocument({
                decision: claim.decision,
                document,
                scopedDb: interruptedDb,
                transfer: null,
              });
          }
        };
        const outcome = await mutate();
        expect(transactions).toBe(2);
        expect(outcome).toEqual({ status: "lost" });
        await mergeOwner.lease?.release();
        expect((await readDecision(decisionId))?.fulltext).toBeNull();
        expect((await readDecision(decisionId))?.documentFetchAttempts).toBe(1);
      });
    }

    for (const failure of ["throw", "abort", "deadline"] as const) {
      test(`${failure} preserves ingestion ownership and abandoned work cannot settle`, async () => {
        const { sourceId, decisionId } = await fixture();
        const crawler = await acquireCaseLawSourceIngestionLease({
          sourceId,
          scopedDb,
        });
        if (crawler === null) {
          panic("crawler fixture missing");
        }
        const controller = new AbortController();
        const started = barrier();
        const continueWork = barrier();
        const lateFinished = barrier();
        let lateRefused = false;
        const run = withDeferredDocumentSourceOwnership({
          decisionId,
          scopedDb,
          signal: controller.signal,
          timeoutMs: failure === "deadline" ? 50 : 1000,
          operation: async (fence) => {
            started.resolve();
            if (failure === "throw") {
              throw new Error("document worker stopped");
            }
            await continueWork.promise;
            const lateResult = await Result.tryPromise({
              try: async () =>
                await fence.scopedDb(
                  async (tx) =>
                    await tx
                      .update(caseLawDecisions)
                      .set({ fulltext: "late document" })
                      .where(eq(caseLawDecisions.id, decisionId)),
                ),
              catch: (error) => error,
            });
            lateRefused = Result.isError(lateResult);
            lateFinished.resolve();
          },
        });
        await started.promise;
        if (failure === "abort") {
          controller.abort(new Error("document cancelled"));
        }
        const stopped = await Result.tryPromise({
          try: async () => await run,
          catch: (error) => error,
        });
        expect(Result.isError(stopped)).toBe(true);
        if (Result.isOk(stopped)) {
          panic("worker did not stop");
        }
        const messages = {
          throw: "document worker stopped",
          abort: "document cancelled",
          deadline: "exceeded 50ms",
        };
        expect(String(stopped.error)).toContain(messages[failure]);
        expect((await readSource(sourceId))?.ingestionLeaseToken).toBe(
          crawler.leaseToken,
        );
        await crawler.release();
        if (failure !== "throw") {
          continueWork.resolve();
          await lateFinished.promise;
          expect(lateRefused).toBe(true);
        }
        expect((await readDecision(decisionId))?.fulltext).toBeNull();
      });
    }
  });
}
