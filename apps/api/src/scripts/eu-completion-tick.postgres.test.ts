import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  databaseBackfillStates,
  euCompletionApprovals,
  euCompletionControls,
  euCompletionReceipts,
} from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { envDbLoadGate } from "@/api/env-db-load-gate";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import { euEcjAdapter } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { ecjCompletionFingerprint } from "@/api/handlers/case-law/ingestion/eu-completion-protection";
import { createEuCompletionStore } from "@/api/handlers/case-law/ingestion/eu-completion-store";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { zstdCompressAsync } from "@/api/lib/compression";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { isUsableStaticCredential } from "@/api/lib/s3/credentials";
import { isRecord } from "@/api/lib/type-guards";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { runEuCompletionTickFixture } from "@/api/tests/helpers/eu-completion-tick";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("EU completion real scheduled wiring", () => {
    test("requires explicit PostgreSQL fixture opt-in", () =>
      expect(true).toBe(true));
  });
} else {
  describe("EU completion real scheduled wiring", () => {
    const { db } = openGatedTestDatabase(databaseUrl);
    const withSource = async (
      run: (sourceId: SafeId<"caseLawSource">) => Promise<void>,
    ) => {
      expect(envBase.DATABASE_URL).toBe(databaseUrl);
      expect(envDbLoadGate.DB_LOAD_GATE_EBS_SIGNAL).toBe("disabled");
      expect(
        envDbLoadGate.DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER,
      ).toBeUndefined();
      const existing = await db
        .select({ id: caseLawSources.id })
        .from(caseLawSources)
        .where(eq(caseLawSources.adapterKey, ADAPTER_KEYS.EU_ECJ));
      if (existing.length !== 0) {
        panic(
          "Scheduled completion fixture requires an unoccupied EU source key",
        );
      }
      const sourceId = createSafeId<"caseLawSource">();
      const previousGlobal = (
        await db
          .select()
          .from(euCompletionControls)
          .where(eq(euCompletionControls.key, "global"))
      ).at(0);
      const previousEnvironment = {
        CASE_LAW_EU_COMPLETION_ENABLED:
          process.env["CASE_LAW_EU_COMPLETION_ENABLED"],
        CASE_LAW_EU_COMPLETION_KILL_SWITCH:
          process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"],
        CASE_LAW_EU_COMPLETION_MODE: process.env["CASE_LAW_EU_COMPLETION_MODE"],
        CASE_LAW_EU_COMPLETION_MAX_ROWS:
          process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"],
      };
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        name: "EU completion scheduled fixture",
      });
      process.env["CASE_LAW_EU_COMPLETION_ENABLED"] = "true";
      process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"] = "false";
      process.env["CASE_LAW_EU_COMPLETION_MODE"] = "apply";
      process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"] = "1";
      try {
        await run(sourceId);
      } finally {
        if (previousEnvironment.CASE_LAW_EU_COMPLETION_ENABLED === undefined) {
          delete process.env["CASE_LAW_EU_COMPLETION_ENABLED"];
        } else {
          process.env["CASE_LAW_EU_COMPLETION_ENABLED"] =
            previousEnvironment.CASE_LAW_EU_COMPLETION_ENABLED;
        }
        if (
          previousEnvironment.CASE_LAW_EU_COMPLETION_KILL_SWITCH === undefined
        ) {
          delete process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"];
        } else {
          process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"] =
            previousEnvironment.CASE_LAW_EU_COMPLETION_KILL_SWITCH;
        }
        if (previousEnvironment.CASE_LAW_EU_COMPLETION_MODE === undefined) {
          delete process.env["CASE_LAW_EU_COMPLETION_MODE"];
        } else {
          process.env["CASE_LAW_EU_COMPLETION_MODE"] =
            previousEnvironment.CASE_LAW_EU_COMPLETION_MODE;
        }
        if (previousEnvironment.CASE_LAW_EU_COMPLETION_MAX_ROWS === undefined) {
          delete process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"];
        } else {
          process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"] =
            previousEnvironment.CASE_LAW_EU_COMPLETION_MAX_ROWS;
        }
        await db
          .delete(euCompletionApprovals)
          .where(eq(euCompletionApprovals.sourceId, sourceId));
        await db
          .delete(euCompletionReceipts)
          .where(eq(euCompletionReceipts.sourceId, sourceId));
        await db.delete(databaseBackfillStates).where(
          inArray(
            databaseBackfillStates.name,
            ["apply", "dry-run"].map(
              (mode) =>
                `eu-completion:${sourceId}:${mode}:${PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ]}`,
            ),
          ),
        );
        await db
          .delete(euCompletionControls)
          .where(eq(euCompletionControls.sourceId, sourceId));
        await db
          .delete(euCompletionControls)
          .where(eq(euCompletionControls.key, "global"));
        if (previousGlobal !== undefined) {
          await db.insert(euCompletionControls).values(previousGlobal);
        }
        await db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    };

    const startCompletionFixtureStorage = () => {
      expect(isUsableStaticCredential(envBase.S3_ACCESS_KEY_ID)).toBe(true);
      expect(isUsableStaticCredential(envBase.S3_SECRET_ACCESS_KEY)).toBe(true);
      const endpoint = envBase.S3_ENDPOINT;
      expect(
        envBase.S3_CREDENTIALS_PROVIDER === "env" ||
          (envBase.S3_CREDENTIALS_PROVIDER === "auto" &&
            endpoint !== undefined &&
            ["localhost", "127.0.0.1", "[::1]"].includes(
              new URL(endpoint).hostname,
            )),
      ).toBe(true);
      return startFakeS3();
    };

    const fetchedApprovedFixture = async (
      sourceId: SafeId<"caseLawSource">,
      offloaded: { textS3Key?: string; astS3Key?: string } = {},
    ) => {
      const store = createEuCompletionStore({ db, now: () => Date.now() });
      const payload = encodeSourceRawEnvelope({
        document: await Bun.file(
          new URL(
            "../handlers/case-law/ingestion/adapters/__fixtures__/eu-ecj-fulltext-en.html",
            import.meta.url,
          ),
        ).text(),
      });
      const metadata = {
        celex: "62021CJ0128",
        ecli: "ECLI:EU:C:2024:49",
        decisionDate: "2024-01-18",
      };
      const parsed = euEcjAdapter.reparseStoredRaw({
        raw: new TextEncoder().encode(payload),
        contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
        caseNumber: "C-128/21",
        sourceDocumentId: null,
        language: "en",
        court: "Court of Justice",
        ecli: metadata.ecli,
        decisionDate: metadata.decisionDate,
        decisionType: null,
        sourceUrl: null,
        documentUrl: null,
        metadata,
      });
      if (parsed.type !== "parsed") {
        panic("Canonical EU fixture failed to parse");
      }
      const candidate = parsed.result;
      const id = createSafeId<"caseLawDecision">();
      await db.insert(caseLawDecisions).values({
        id,
        sourceId,
        caseNumber: candidate.caseNumber,
        sourceDocumentId: candidate.sourceDocumentId,
        court: candidate.court,
        country: candidate.country,
        language: candidate.language,
        ecli: candidate.ecli,
        decisionDate: candidate.decisionDate,
        decisionType: candidate.decisionType,
        sourceUrl: candidate.sourceUrl,
        documentUrl: candidate.documentUrl,
        metadata,
        ...offloaded,
        parserVersion: 1,
      });
      const row = (
        await db
          .select()
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, id))
      ).at(0);
      if (row === undefined) {
        panic("Missing completion fixture decision");
      }
      const claimedFingerprint = ecjCompletionFingerprint({
        existing: row,
        judges: [],
      });
      const options = {
        sourceId,
        parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
        limit: 1,
      };
      const reserveFetched = async (mode: "dry-run" | "apply") => {
        const receipt = (await store.reserve({ ...options, mode })).at(0);
        if (receipt === undefined) {
          panic("Missing completion fixture receipt");
        }
        expect(await store.pickup(receipt.id)).toBe("ready");
        const fetched = await store.markFetched({
          id: receipt.id,
          payload,
          payloadHash: new Bun.CryptoHasher("sha256")
            .update(payload)
            .digest("hex"),
          claimedFingerprint,
          target: "full",
          provenance: { requestHashes: [], requestedSurfaces: [] },
        });
        if (fetched === null) {
          panic("Missing fetched completion fixture");
        }
        return fetched;
      };
      const dry = await reserveFetched("dry-run");
      await store.finish({ id: dry.id, status: "dry-run" });
      const approvedAt = new Date();
      await store.approveSupervisedDryRun({
        sourceId,
        parserVersion: options.parserVersion,
        supervisedReceiptId: dry.id,
        evidenceRef: "fixture://canonical-completion",
        supervisedBy: "fixture-supervisor",
        supervisedAt: approvedAt,
        approvedBy: "fixture-approver",
        approvedAt,
      });
      for (const controlSource of [null, sourceId]) {
        await store.setControl({
          sourceId: controlSource,
          state: "on",
          changedBy: "fixture",
          changedAt: new Date(),
        });
      }
      const receipt = await reserveFetched("apply");
      return { store, receipt, row, candidate };
    };

    test("actual scheduled wiring recovers an approved fetched envelope through the canonical writer", async () => {
      await withSource(async (sourceId) => {
        const storage = startCompletionFixtureStorage();
        try {
          const { store, receipt, row, candidate } =
            await fetchedApprovedFixture(sourceId);
          const report = await runEuCompletionTickFixture(
            AbortSignal.timeout(20_000),
            { healthConfig: { busyWindows: [] } },
          );
          expect(report).toMatchObject({
            status: "completed",
            attempted: 1,
            applied: 1,
            failed: 0,
            requests: 0,
          });
          const written = (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, row.id))
          ).at(0);
          if (written === undefined) {
            panic("Canonical completion lost its decision");
          }
          expect(written.fulltext).toBe(candidate.fulltext);
          expect(written.parserVersion).toBe(
            PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
          );
          expect(written.corpusMirrorStatus).toBe("settled");
          expect(await store.getReceipt(receipt.id)).toMatchObject({
            status: "applied",
            writtenParserVersion: written.parserVersion,
            writtenSourceHash: written.sourceHash,
            writtenObservationOrder: written.sourceObservationOrder,
          });
          expect(
            storage.requests.some((request) => request.method === "PUT"),
          ).toBe(true);
          expect(
            (
              await db
                .select()
                .from(caseLawSources)
                .where(eq(caseLawSources.id, sourceId))
            ).at(0)?.ingestionLeaseToken,
          ).toBeNull();
        } finally {
          storage.stop();
        }
      });
    }, 30_000);

    for (const statement of ["text", "ast"] as const) {
      test(`actual scheduled wiring preserves an offloaded ${statement} statement on conflict`, async () => {
        await withSource(async (sourceId) => {
          const storage = startCompletionFixtureStorage();
          try {
            const key = `legal-corpus/fixture/${sourceId}/${statement}.zst`;
            const offloaded =
              statement === "text" ? { textS3Key: key } : { astS3Key: key };
            const { store, receipt, row, candidate } =
              await fetchedApprovedFixture(sourceId, offloaded);
            const storedAst = candidate.documentAst;
            if (!("metadata" in storedAst)) {
              panic("Canonical fixture needs a complete document AST");
            }
            const payload =
              statement === "text"
                ? "Previously stored publisher statement"
                : JSON.stringify({
                    ...storedAst,
                    metadata: {
                      ...storedAst.metadata,
                      caseNumber: "C-preserved/21",
                    },
                  });
            storage.put(
              envBase.LEGAL_CORPUS_S3_BUCKET ?? envBase.S3_BUCKET,
              key,
              await zstdCompressAsync(payload),
              "application/zstd",
            );
            const objectsBefore = [...storage.objects.entries()];
            const report = await runEuCompletionTickFixture(
              AbortSignal.timeout(20_000),
              { healthConfig: { busyWindows: [] } },
            );
            expect(report).toMatchObject({
              status: "completed",
              applied: 0,
              reviewRequired: 1,
              requests: 0,
            });
            expect(
              (
                await db
                  .select()
                  .from(caseLawDecisions)
                  .where(eq(caseLawDecisions.id, row.id))
              ).at(0),
            ).toEqual(row);
            expect((await store.getReceipt(receipt.id))?.status).toBe(
              "review-required",
            );
            expect(
              storage.requests.some(
                (request) => request.method === "GET" && request.key === key,
              ),
            ).toBe(true);
            expect(
              storage.requests.some((request) => request.method === "PUT"),
            ).toBe(false);
            expect([...storage.objects.entries()]).toEqual(objectsBefore);
          } finally {
            storage.stop();
          }
        });
      }, 30_000);
    }

    test("receipt hooks use the owner around the ingestion role and roll back the row and marker together", async () => {
      await withSource(async (sourceId) => {
        const { store, receipt, row } = await fetchedApprovedFixture(sourceId);
        const roles: string[] = [];
        const captureRole = async (tx: Transaction) => {
          const result = executedRows(
            await tx.execute(sql`SELECT current_user AS role`),
          ).at(0);
          const role = isRecord(result) ? result["role"] : undefined;
          if (typeof role !== "string") {
            panic("Missing fixture transaction role");
          }
          roles.push(role);
        };
        const guardedDb = createIngestionDb(markRlsDatabase(db), {
          maintenance: {
            before: async (tx) => {
              await captureRole(tx);
              expect(await store.assertApprovalTx(tx, receipt)).toBe(true);
              expect(
                await store.assertFetchedTx(tx, receipt.id),
              ).not.toBeNull();
            },
            after: async (tx) => {
              await captureRole(tx);
              await store.markWrittenTx(tx, {
                id: receipt.id,
                decisionId: row.id,
              });
              panic("Fixture abort after canonical marker");
            },
          },
        });
        const outcome = await Result.tryPromise(
          async () =>
            await guardedDb(async (tx) => {
              await captureRole(tx);
              await tx
                .update(caseLawDecisions)
                .set({
                  sourceHash: "fixture-canonical-hash",
                  parserVersion: receipt.parserVersion,
                  sourceObservationOrder: 1n,
                })
                .where(eq(caseLawDecisions.id, row.id));
            }),
        );
        expect(outcome.isErr()).toBe(true);
        expect(roles).toHaveLength(3);
        expect(roles.at(0)).not.toBe("stella_ingestion");
        expect(roles.at(1)).toBe("stella_ingestion");
        expect(roles.at(2)).toBe(roles.at(0));
        expect(
          (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, row.id))
          ).at(0),
        ).toEqual(row);
        expect(await store.getReceipt(receipt.id)).toEqual(receipt);
      });
    });

    test("enabled environment cannot bypass durable off controls or acquire a source writer", async () => {
      await withSource(async (sourceId) => {
        const store = createEuCompletionStore({ db, now: () => Date.now() });
        await store.setControl({
          sourceId: null,
          state: "off",
          changedBy: "fixture",
          changedAt: new Date(),
        });
        await store.setControl({
          sourceId,
          state: "off",
          changedBy: "fixture",
          changedAt: new Date(),
        });
        const result = await runEuCompletionTickFixture(
          AbortSignal.timeout(10_000),
          { healthConfig: { busyWindows: [] } },
        );
        expect(result).toMatchObject({
          status: "off",
          attempted: 0,
          requests: 0,
        });
        expect(
          (
            await db
              .select()
              .from(caseLawSources)
              .where(eq(caseLawSources.id, sourceId))
          ).at(0)?.ingestionLeaseToken,
        ).toBeNull();
        expect(
          await db
            .select()
            .from(euCompletionReceipts)
            .where(eq(euCompletionReceipts.sourceId, sourceId)),
        ).toHaveLength(0);
      });
    });

    test("the real gate admits the session but apply refuses absent durable supervised approval", async () => {
      await withSource(async (sourceId) => {
        const store = createEuCompletionStore({ db, now: () => Date.now() });
        await store.setControl({
          sourceId: null,
          state: "on",
          changedBy: "fixture",
          changedAt: new Date(),
        });
        await store.setControl({
          sourceId,
          state: "on",
          changedBy: "fixture",
          changedAt: new Date(),
        });
        const id = createSafeId<"caseLawDecision">();
        await db.insert(caseLawDecisions).values({
          id,
          sourceId,
          caseNumber: "C-1/26",
          court: "Court of Justice",
          country: "EU",
          language: "en",
          parserVersion: 1,
        });
        const before = (
          await db
            .select()
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, id))
        ).at(0);
        const result = await runEuCompletionTickFixture(
          AbortSignal.timeout(10_000),
          { healthConfig: { busyWindows: [] } },
        );
        expect(result).toMatchObject({
          status: "approval-required",
          attempted: 0,
          requests: 0,
        });
        expect(
          (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, id))
          ).at(0),
        ).toEqual(before);
        expect(
          await db
            .select()
            .from(euCompletionReceipts)
            .where(
              and(
                eq(euCompletionReceipts.sourceId, sourceId),
                eq(euCompletionReceipts.mode, "apply"),
              ),
            ),
        ).toHaveLength(0);
        expect(
          (
            await db
              .select()
              .from(caseLawSources)
              .where(eq(caseLawSources.id, sourceId))
          ).at(0)?.ingestionLeaseToken,
        ).toBeNull();
        expect(await store.loadControls(sourceId)).toEqual({
          global: "on",
          source: "on",
        });
      });
    });
  });
}
