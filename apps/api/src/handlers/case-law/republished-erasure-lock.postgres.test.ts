import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawSources,
} from "@/api/db/schema";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { createSafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { applyRepublishedDecisionBatch } from "@/api/scripts/link-republished-decisions-plan";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("republished decision erasure locking (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("republished decision erasure locking (postgres)", () => {
    test("linking and erasure coordinate when the retired id sorts first", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const owner = openClient();
        const linker = openClient();
        const eraser = openClient();
        const canonicalSource = createSafeId<"caseLawSource">();
        const republisherSource = createSafeId<"caseLawSource">();
        const retiredId = brandPersistedCaseLawDecisionId(
          "00000000-0000-4000-8000-000000000001",
        );
        const canonicalId = brandPersistedCaseLawDecisionId(
          "ffffffff-ffff-4fff-bfff-ffffffffffff",
        );
        const decisionIds = [retiredId, canonicalId];
        expect(retiredId < canonicalId).toBe(true);
        const candidate = {
          canonical: {
            adapterKey: ADAPTER_KEYS.PL_TK,
            createdAt: new Date("2026-10-01"),
            id: canonicalId,
          },
          duplicate: {
            adapterKey: ADAPTER_KEYS.PL_COURTS,
            createdAt: new Date("2026-10-02"),
            id: retiredId,
          },
          disposition: "link" as const,
        };
        const common = {
          country: "POL",
          court: "Concurrency fixture court",
          language: "pl",
          caseNumber: `lock-${canonicalId}`,
        };
        await owner.db.insert(caseLawSources).values([
          {
            id: canonicalSource,
            adapterKey: ADAPTER_KEYS.PL_TK,
            name: "Concurrency fixture court",
          },
          {
            id: republisherSource,
            adapterKey: ADAPTER_KEYS.PL_COURTS,
            name: "Concurrency fixture republisher",
          },
        ]);
        await owner.db.insert(caseLawDecisions).values([
          {
            ...common,
            id: canonicalId,
            sourceId: canonicalSource,
            sourceDocumentId: "canonical",
            fulltext: "canonical payload",
          },
          {
            ...common,
            id: retiredId,
            sourceId: republisherSource,
            sourceDocumentId: "retired",
            fulltext: "retired payload",
          },
        ]);
        await owner.db.insert(caseLawDecisionSourceIdentities).values([
          {
            sourceId: canonicalSource,
            sourceDocumentId: "canonical",
            decisionId: canonicalId,
          },
          {
            sourceId: republisherSource,
            sourceDocumentId: "retired",
            decisionId: retiredId,
          },
        ]);

        const sweepRaw = async () => ({
          type: "swept" as const,
          legacy: "none" as const,
        });
        const directScopedDb = asTestRaw<ScopedDb>(
          async (callback: (tx: typeof eraser.db) => Promise<unknown>) =>
            await eraser.db.transaction(
              async (tx) => await callback(asTestRaw(tx)),
            ),
        );
        let releaseLink: (() => void) | undefined;
        let markLinkReady: (() => void) | undefined;
        const linkReady = new Promise<void>((resolve) => {
          markLinkReady = resolve;
        });
        const linking = linker.db.transaction(async (tx) => {
          await applyRepublishedDecisionBatch(
            tx,
            [candidate],
            async () => undefined,
          );
          markLinkReady?.();
          await new Promise<void>((resolve) => {
            releaseLink = resolve;
          });
        });
        await linkReady;
        const erasingAfterLink = redactCaseLawDecision({
          decisionId: canonicalId,
          scopedDb: directScopedDb,
          sweepRaw,
        });
        await Bun.sleep(50);
        expect(await owner.db.select().from(caseLawDecisionAliases)).toEqual(
          [],
        );
        releaseLink?.();
        await linking;
        const linkedErasure = await erasingAfterLink;
        if (Result.isError(linkedErasure)) {
          throw linkedErasure.error;
        }
        expect(linkedErasure.value.type).toBe("redacted");
        expect(
          await owner.db
            .select({
              id: caseLawDecisions.id,
              redactedAt: caseLawDecisions.redactedAt,
              fulltext: caseLawDecisions.fulltext,
            })
            .from(caseLawDecisions)
            .where(inArray(caseLawDecisions.id, decisionIds)),
        ).toEqual(
          expect.arrayContaining(
            decisionIds.map((id) => ({
              id,
              redactedAt: expect.any(Date),
              fulltext: null,
            })),
          ),
        );

        await owner.db
          .delete(caseLawDecisionAliases)
          .where(eq(caseLawDecisionAliases.retiredDecisionId, retiredId));
        await owner.db
          .update(caseLawDecisions)
          .set({ redactedAt: null })
          .where(inArray(caseLawDecisions.id, decisionIds));
        let releaseErasure: (() => void) | undefined;
        let markErasureReady: (() => void) | undefined;
        let holdFirstTransaction = true;
        const erasureReady = new Promise<void>((resolve) => {
          markErasureReady = resolve;
        });
        const heldScopedDb = asTestRaw<ScopedDb>(
          async (operation: (tx: typeof eraser.db) => Promise<unknown>) =>
            await eraser.db.transaction(async (tx) => {
              const result = await operation(asTestRaw(tx));
              if (holdFirstTransaction) {
                holdFirstTransaction = false;
                markErasureReady?.();
                await new Promise<void>((resolve) => {
                  releaseErasure = resolve;
                });
              }
              return result;
            }),
        );
        const heldErasure = redactCaseLawDecision({
          decisionId: canonicalId,
          scopedDb: heldScopedDb,
          sweepRaw,
        });
        await erasureReady;
        const linkingAfterErasure = linker.db.transaction(
          async (tx) =>
            await applyRepublishedDecisionBatch(tx, [candidate], async () =>
              panic("An erased pair must not be reconciled"),
            ),
        );
        await Bun.sleep(50);
        releaseErasure?.();
        const [erasureOutcome, linkOutcome] = await Promise.all([
          heldErasure,
          linkingAfterErasure,
        ]);
        if (Result.isError(erasureOutcome)) {
          throw erasureOutcome.error;
        }
        expect(linkOutcome).toEqual([{ type: "skipped_erased", retiredId }]);

        await owner.db
          .delete(caseLawDecisionSourceIdentities)
          .where(
            inArray(caseLawDecisionSourceIdentities.decisionId, decisionIds),
          );
        await owner.db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, decisionIds));
        await owner.db
          .delete(caseLawSources)
          .where(
            inArray(caseLawSources.id, [canonicalSource, republisherSource]),
          );
      });
    }, 30_000);
  });
}
