import { panic, Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  databaseBackfillStates,
  euCompletionApprovals,
  euCompletionControls,
  euCompletionReceipts,
  euCompletionRequestHours,
} from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { envDbLoadGate } from "@/api/env-db-load-gate";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import sparqlFixture from "@/api/handlers/case-law/ingestion/adapters/__fixtures__/eu-ecj-sparql.json";
import { euEcjAdapter } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import {
  withPublisherGateFixture,
  abortableSleep,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { fetchPublisher } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { ecjCompletionFingerprint } from "@/api/handlers/case-law/ingestion/eu-completion-protection";
import { createEuCompletionStore } from "@/api/handlers/case-law/ingestion/eu-completion-store";
import { parseEcjNotice } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-notice";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { zstdCompressAsync } from "@/api/lib/compression";
import { executedRows } from "@/api/lib/db/executed-rows";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { isUsableStaticCredential } from "@/api/lib/s3/credentials";
import { isRecord } from "@/api/lib/type-guards";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { runEuCompletionTickFixture } from "@/api/tests/helpers/eu-completion-tick";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

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
      options: {
        offloaded?: { textS3Key?: string; astS3Key?: string };
        receiptStage?: "fetched" | "pending";
      } = {},
    ) => {
      const store = createEuCompletionStore({
        db,
        now: () => Temporal.Now.instant().epochMilliseconds,
      });
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
        decisionType: "judgment",
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
        ...options.offloaded,
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
      const reservation = {
        sourceId,
        parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
        limit: 1,
      };
      const reserveFetched = async (mode: "dry-run" | "apply") => {
        const receipt = (await store.reserve({ ...reservation, mode })).at(0);
        if (receipt === undefined) {
          panic("Missing completion fixture receipt");
        }
        if (mode === "apply" && options.receiptStage === "pending") {
          return receipt;
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
        if (fetched.isErr()) {
          panic("Completion fixture exceeds its row byte limit");
        }
        if (fetched.value === null) {
          panic("Missing fetched completion fixture");
        }
        return fetched.value;
      };
      const dry = await reserveFetched("dry-run");
      await store.finish({ id: dry.id, status: "dry-run" });
      const approvedAt = new Date();
      const approval = await store.approveSupervisedDryRun({
        sourceId,
        parserVersion: reservation.parserVersion,
        supervisedReceiptId: dry.id,
        evidenceRef: "fixture://canonical-completion",
        reviewedCounts: { reviewed: 1, accepted: 1, requiresReview: 0 },
        supervisedBy: "fixture-supervisor",
        supervisedAt: approvedAt,
        approvedBy: "fixture-approver",
        approvedAt,
      });
      if (approval.isErr()) {throw approval.error;}
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

    const fixtureGate = () => {
      let nextSendAt = 0;
      let cooldownUntil = 0;
      const reservations: number[] = [];
      const dependencies = {
        redis: () => ({
          send: (_command: string, args: string[]) => {
            const clock = Temporal.Now.instant().epochMilliseconds;
            if (args.at(2)?.endsWith(":cooldown")) {
              const delay = args.at(3);
              if (delay !== undefined) {
                cooldownUntil = Math.max(cooldownUntil, clock + Number(delay));
                return cooldownUntil;
              }
              if (args.at(0)?.includes("return untilAt > now")) {
                return cooldownUntil > clock ? cooldownUntil : 0;
              }
              return Math.max(0, cooldownUntil - clock);
            }
            const slot = Math.max(clock, nextSendAt, cooldownUntil);
            reservations.push(slot);
            nextSendAt = slot + Number(args.at(-1));
            return slot - clock;
          },
        }),
        sleep: abortableSleep,
      };
      return { dependencies, reservations, cooldownUntil: () => cooldownUntil };
    };
    const withPublisher = async (options: {
      respond: (url: string, init?: RequestInit) => Promise<Response>;
      run: (sent: { url: string; at: number }[]) => Promise<void>;
    }) => {
      const original = globalThis.fetch;
      const sent: { url: string; at: number }[] = [];
      globalThis.fetch = asFetchMock(
        mock(async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          const host = new URL(url).hostname;
          if (!["publications.europa.eu", "eur-lex.europa.eu"].includes(host)) {
            panic("Completion publisher fixture refuses an unrelated host");
          }
          sent.push({ url, at: Temporal.Now.instant().epochMilliseconds });
          return await options.respond(url, init);
        }),
      );
      try {
        await options.run(sent);
      } finally {
        globalThis.fetch = original;
      }
    };
    const successfulPublisher = async (url: string, init?: RequestInit) => {
      if (url.includes("sparql")) {
        const binding = sparqlFixture.results.bindings.at(
          typeof init?.body === "string" && init.body.includes("62021CJ0367")
            ? 1
            : 0,
        );
        if (binding === undefined) {
          panic("Missing canonical SPARQL fixture binding");
        }
        return new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  ...binding,
                  language: {
                    type: "uri",
                    value:
                      "http://publications.europa.eu/resource/authority/language/ENG",
                  },
                  manifestation: {
                    type: "uri",
                    value:
                      "http://publications.europa.eu/resource/cellar/5980acd6-b5e4-11ee-b164-01aa75ed71a1.0011.05",
                  },
                },
              ],
            },
          }),
          { headers: { "Content-Type": "application/sparql-results+json" } },
        );
      }
      if (url.includes("/resource/cellar/")) {
        return new Response(
          await Bun.file(
            new URL(
              "../handlers/case-law/ingestion/adapters/__fixtures__/eu-ecj-fulltext-en.html",
              import.meta.url,
            ),
          ).text(),
          { headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response(null, { status: 404 });
    };

    test("actual dry-run fetches through its gate while preserving every decision byte", async () => {
      await withSource(async (sourceId) => {
        const { row } = await fetchedApprovedFixture(sourceId, {
          receiptStage: "pending",
        });
        process.env["CASE_LAW_EU_COMPLETION_MODE"] = "dry-run";
        const gate = fixtureGate();
        await withPublisher({
          respond: successfulPublisher,
          run: async (sent) => {
            const report = await withPublisherGateFixture(
              gate.dependencies,
              async () =>
                await runEuCompletionTickFixture(AbortSignal.timeout(20_000), {
                  healthConfig: { busyWindows: [] },
                }),
            );
            expect(report).toMatchObject({
              status: "completed",
              attempted: 1,
              applied: 0,
              reviewRequired: 0,
            });
            expect(report.requests).toBe(sent.length);
            expect(sent.length).toBeGreaterThan(1);
            expect(gate.reservations.length).toBe(sent.length);
            expect(
              (
                await db
                  .select()
                  .from(caseLawDecisions)
                  .where(eq(caseLawDecisions.id, row.id))
              ).at(0),
            ).toEqual(row);
            expect(
              (
                await db
                  .select()
                  .from(euCompletionReceipts)
                  .where(
                    and(
                      eq(euCompletionReceipts.sourceId, sourceId),
                      eq(euCompletionReceipts.mode, "dry-run"),
                    ),
                  )
              ).some((receipt) => receipt.status === "dry-run"),
            ).toBe(true);
          },
        });
      });
    }, 30_000);

    test.each([429, 403])(
      "actual completion treats HTTP %s as a one-request stopped publisher refusal",
      async (status) => {
        await withSource(async (sourceId) => {
          const { row, store, receipt } = await fetchedApprovedFixture(
            sourceId,
            { receiptStage: "pending" },
          );
          const gate = fixtureGate();
          await withPublisher({
            respond: async () =>
              new Response(null, { status, headers: { "Retry-After": "60" } }),
            run: async (sent) => {
              const report = await withPublisherGateFixture(
                gate.dependencies,
                async () =>
                  await runEuCompletionTickFixture(
                    AbortSignal.timeout(20_000),
                    { healthConfig: { busyWindows: [] } },
                  ),
              );
              expect(report).toMatchObject({
                status: "publisher-refused",
                requests: 1,
                attempted: 1,
                applied: 0,
              });
              expect(sent).toHaveLength(1);
              expect((await store.getReceipt(receipt.id))?.status).toBe(
                "publisher-refused",
              );
              expect(gate.cooldownUntil()).toBeGreaterThan(
                Temporal.Now.instant().epochMilliseconds,
              );
              expect(
                (await store.loadSourceGateState(sourceId)).holdUntil,
              ).toBeGreaterThan(Temporal.Now.instant().epochMilliseconds);
              expect(
                (
                  await db
                    .select()
                    .from(caseLawDecisions)
                    .where(eq(caseLawDecisions.id, row.id))
                ).at(0),
              ).toEqual(row);
            },
          });
        });
      },
      30_000,
    );

    test.each([
      { surface: "notice", status: 403 },
      { surface: "notice", status: 503 },
      { surface: "formex", status: 403 },
      { surface: "formex", status: 503 },
    ] as const)(
      "HTTP $status at the final $surface response stops before the adjacent document",
      async ({ surface, status }) => {
        await withSource(async (sourceId) => {
          const { row, store, receipt } = await fetchedApprovedFixture(
            sourceId,
            { receiptStage: "pending" },
          );
          const secondId = createSafeId<"caseLawDecision">();
          await db.insert(caseLawDecisions).values({
            ...row,
            id: secondId,
            caseNumber: "C-367/21",
            sourceDocumentId: "62021CJ0367:en",
            ecli: "ECLI:EU:C:2024:61",
            metadata: {
              celex: "62021CJ0367",
              ecli: "ECLI:EU:C:2024:61",
              decisionDate: "2024-01-18",
            },
          });
          process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"] = "2";
          const notice = new TextDecoder().decode(
            Bun.gunzipSync(
              await Bun.file(
                new URL(
                  "../handlers/case-law/ingestion/adapters/__fixtures__/eu-ecj-notice-en.xml.gz",
                  import.meta.url,
                ),
              ).bytes(),
            ),
          );
          const formex = parseEcjNotice(notice).manifestations.find(
            (manifestation) => manifestation.type === "fmx4",
          );
          if (formex === undefined) {
            panic("Canonical notice fixture has no Formex manifestation");
          }
          const formexUrl = `${formex.uri.replace("http://", "https://")}/DOC_1`;
          const stoppedUrl =
            surface === "formex"
              ? formexUrl
              : "https://publications.europa.eu/resource/celex/62021CJ0128";
          const gate = fixtureGate();
          await withPublisher({
            respond: async (url, init) => {
              if (url === stoppedUrl) {
                return new Response(null, {
                  status,
                  headers: { "Retry-After": "60" },
                });
              }
              if (surface === "formex" && url.includes("/resource/celex/")) {
                return new Response(notice, {
                  headers: { "Content-Type": "application/xml" },
                });
              }
              return await successfulPublisher(url, init);
            },
            run: async (sent) => {
              const report = await withPublisherGateFixture(
                gate.dependencies,
                async () =>
                  await runEuCompletionTickFixture(
                    AbortSignal.timeout(20_000),
                    { healthConfig: { busyWindows: [] } },
                  ),
              );
              expect(report).toMatchObject({
                status: status === 403 ? "publisher-refused" : "failed",
                attempted: 1,
                applied: 0,
              });
              expect(sent).toHaveLength(surface === "notice" ? 3 : 4);
              expect(sent.at(-1)?.url).toBe(stoppedUrl);
              expect(report.requests).toBe(sent.length);
              expect(
                (await store.loadSourceGateState(sourceId)).holdUntil,
              ).toBeGreaterThan(Temporal.Now.instant().epochMilliseconds);
              if (status === 403) {
                expect((await store.getReceipt(receipt.id))?.status).toBe(
                  "publisher-refused",
                );
                expect(gate.cooldownUntil()).toBeGreaterThan(
                  Temporal.Now.instant().epochMilliseconds,
                );
              }
              expect(
                (
                  await db
                    .select()
                    .from(caseLawDecisions)
                    .where(eq(caseLawDecisions.id, row.id))
                ).at(0),
              ).toEqual(row);
              expect(
                (
                  await db
                    .select()
                    .from(caseLawDecisions)
                    .where(eq(caseLawDecisions.id, secondId))
                ).at(0)?.parserVersion,
              ).toBe(1);
              expect(
                (
                  await db
                    .select()
                    .from(euCompletionReceipts)
                    .where(eq(euCompletionReceipts.decisionId, secondId))
                ).every((adjacent) => adjacent.attempts === 0),
              ).toBe(true);
            },
          });
        });
      },
      30_000,
    );

    test("Redis reservation failure sends no publisher request through the actual tick", async () => {
      await withSource(async (sourceId) => {
        await fetchedApprovedFixture(sourceId, { receiptStage: "pending" });
        await withPublisher({
          respond: successfulPublisher,
          run: async (sent) => {
            const report = await withPublisherGateFixture(
              {
                redis: () => ({
                  send: () => {
                    throw new TypeError("Fixture Redis unavailable");
                  },
                }),
                sleep: abortableSleep,
              },
              async () =>
                await runEuCompletionTickFixture(AbortSignal.timeout(20_000), {
                  healthConfig: { busyWindows: [] },
                }),
            );
            expect(report.status).toBe("failed");
            expect(sent).toHaveLength(0);
          },
        });
      });
    }, 30_000);

    test("a stale reservation touched by the crawl stops before publisher traffic", async () => {
      await withSource(async (sourceId) => {
        const { store, receipt, row } = await fetchedApprovedFixture(sourceId, {
          receiptStage: "pending",
        });
        await db
          .update(caseLawDecisions)
          .set({ sourceHash: "fixture-live-crawl" })
          .where(eq(caseLawDecisions.id, row.id));
        await withPublisher({
          respond: successfulPublisher,
          run: async (sent) => {
            const report = await runEuCompletionTickFixture(
              AbortSignal.timeout(20_000),
              { healthConfig: { busyWindows: [] } },
            );
            expect(report.applied).toBe(0);
            expect(sent).toHaveLength(0);
            expect((await store.getReceipt(receipt.id))?.status).toBe(
              "superseded-by-crawl",
            );
          },
        });
      });
    }, 30_000);

    test("a live crawl source lease prevents completion fetch and is not stolen", async () => {
      await withSource(async (sourceId) => {
        await fetchedApprovedFixture(sourceId, { receiptStage: "pending" });
        const lease = await acquireCaseLawSourceIngestionLease({
          scopedDb: createIngestionDb(markRlsDatabase(db)),
          sourceId,
        });
        if (lease === null) {
          panic("Fixture failed to acquire source lease");
        }
        try {
          await withPublisher({
            respond: successfulPublisher,
            run: async (sent) => {
              const report = await runEuCompletionTickFixture(
                AbortSignal.timeout(20_000),
                { healthConfig: { busyWindows: [] } },
              );
              expect(report.status).toBe("held");
              expect(sent).toHaveLength(0);
              expect(
                (
                  await db
                    .select()
                    .from(caseLawSources)
                    .where(eq(caseLawSources.id, sourceId))
                ).at(0)?.ingestionLeaseToken,
              ).toBe(lease.leaseToken);
            },
          });
        } finally {
          await lease.release();
        }
      });
    }, 30_000);

    test("missing durable approval blocks a pending fetch and every decision write", async () => {
      await withSource(async (sourceId) => {
        const { row } = await fetchedApprovedFixture(sourceId, {
          receiptStage: "pending",
        });
        await db
          .delete(euCompletionApprovals)
          .where(eq(euCompletionApprovals.sourceId, sourceId));
        await withPublisher({
          respond: successfulPublisher,
          run: async (sent) => {
            const report = await runEuCompletionTickFixture(
              AbortSignal.timeout(20_000),
              { healthConfig: { busyWindows: [] } },
            );
            expect(report).toMatchObject({
              status: "approval-required",
              attempted: 0,
              requests: 0,
              applied: 0,
            });
            expect(sent).toHaveLength(0);
            expect(
              (
                await db
                  .select()
                  .from(caseLawDecisions)
                  .where(eq(caseLawDecisions.id, row.id))
              ).at(0),
            ).toEqual(row);
          },
        });
      });
    }, 30_000);

    test("a saturated durable hourly budget prevents the first HTTP send", async () => {
      await withSource(async (sourceId) => {
        await fetchedApprovedFixture(sourceId, { receiptStage: "pending" });
        const hour = new Date(
          Math.floor(Temporal.Now.instant().epochMilliseconds / 3_600_000) *
            3_600_000,
        );
        const previous = (
          await db
            .select()
            .from(euCompletionRequestHours)
            .where(eq(euCompletionRequestHours.hour, hour))
        ).at(0);
        await db
          .insert(euCompletionRequestHours)
          .values({ hour, requests: 3600 })
          .onConflictDoUpdate({
            target: euCompletionRequestHours.hour,
            set: { requests: 3600 },
          });
        try {
          await withPublisher({
            respond: successfulPublisher,
            run: async (sent) => {
              const gate = fixtureGate();
              const report = await withPublisherGateFixture(
                gate.dependencies,
                async () =>
                  await runEuCompletionTickFixture(
                    AbortSignal.timeout(20_000),
                    { healthConfig: { busyWindows: [] } },
                  ),
              );
              expect(report).toMatchObject({
                status: "request-budget",
                requests: 0,
                applied: 0,
              });
              expect(sent).toHaveLength(0);
              expect(gate.reservations).toHaveLength(0);
            },
          });
        } finally {
          await db
            .delete(euCompletionRequestHours)
            .where(eq(euCompletionRequestHours.hour, hour));
          if (previous !== undefined) {
            await db.insert(euCompletionRequestHours).values(previous);
          }
        }
      });
    }, 30_000);

    test("the real load verdict rejects work before publisher traffic or pickup", async () => {
      await withSource(async (sourceId) => {
        const { store, receipt } = await fetchedApprovedFixture(sourceId, {
          receiptStage: "pending",
        });
        await withPublisher({
          respond: successfulPublisher,
          run: async (sent) => {
            const report = await runEuCompletionTickFixture(
              AbortSignal.timeout(20_000),
              {
                healthConfig: {
                  busyWindows: [
                    { start: "00:00", end: "23:59", timeZone: "UTC" },
                    { start: "23:58", end: "00:01", timeZone: "UTC" },
                  ],
                },
              },
            );
            expect(report).toMatchObject({
              status: "held",
              attempted: 0,
              requests: 0,
            });
            expect(sent).toHaveLength(0);
            expect((await store.getReceipt(receipt.id))?.attempts).toBe(0);
          },
        });
      });
    }, 30_000);

    test("an occupied heavy-work slot rejects the actual tick before requests", async () => {
      await withSource(async (sourceId) => {
        await fetchedApprovedFixture(sourceId, { receiptStage: "pending" });
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const session = await openClient().sql.reserve();
          const slot = createHeavyWorkSlot({
            kind: "operator_job",
            session: {
              query: async (statement, parameters) =>
                await session.unsafe<{ acquired: boolean }[]>(statement, [
                  ...parameters,
                ]),
            },
          });
          try {
            const acquired = await slot.tryAcquire();
            expect(acquired.isOk()).toBe(true);
            if (acquired.isOk()) {
              expect(acquired.value).toBe(true);
            }
            await withPublisher({
              respond: successfulPublisher,
              run: async (sent) => {
                const report = await runEuCompletionTickFixture(
                  AbortSignal.timeout(20_000),
                  { healthConfig: { busyWindows: [] } },
                );
                expect(report.status).toBe("held");
                expect(sent).toHaveLength(0);
              },
            });
          } finally {
            await slot.close();
            session.release();
          }
        });
      });
    }, 30_000);

    test("the job run slot shares send spacing with an ordinary crawl request", async () => {
      await withSource(async (sourceId) => {
        await fetchedApprovedFixture(sourceId, { receiptStage: "pending" });
        process.env["CASE_LAW_EU_COMPLETION_MODE"] = "dry-run";
        const gate = fixtureGate();
        await withPublisher({
          respond: successfulPublisher,
          run: async (sent) => {
            await withPublisherGateFixture(gate.dependencies, async () => {
              await fetchPublisher(
                "https://publications.europa.eu/completion-crawl-fixture",
                { adapterKey: ADAPTER_KEYS.EU_ECJ, timeoutMs: 1000 },
              );
              const report = await runEuCompletionTickFixture(
                AbortSignal.timeout(20_000),
                { healthConfig: { busyWindows: [] } },
              );
              expect(report.requests).toBe(sent.length - 1);
            });
            expect(sent.length).toBeGreaterThan(2);
            for (let index = 1; index < sent.length; index++) {
              const previous = sent.at(index - 1);
              const current = sent.at(index);
              if (previous === undefined || current === undefined) {
                panic("Missing paced fixture send");
              }
              expect(current.at - previous.at).toBeGreaterThanOrEqual(1000);
            }
          },
        });
      });
    }, 30_000);

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
              await fetchedApprovedFixture(sourceId, { offloaded });
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

    test("a live crawl can acquire the real source lease between two completion documents", async () => {
      await withSource(async (sourceId) => {
        const storage = startCompletionFixtureStorage();
        try {
          const { store, row, candidate } =
            await fetchedApprovedFixture(sourceId);
          const secondId = createSafeId<"caseLawDecision">();
          await db.insert(caseLawDecisions).values({
            ...row,
            id: secondId,
            caseNumber: "C-367/21",
            sourceDocumentId: "62021CJ0367:en",
            ecli: "ECLI:EU:C:2024:61",
            metadata: {
              celex: "62021CJ0367",
              ecli: "ECLI:EU:C:2024:61",
              decisionDate: "2024-01-18",
            },
          });
          const secondRow = (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, secondId))
          ).at(0);
          if (secondRow === undefined) {
            panic("Missing adjacent completion fixture row");
          }
          const secondReceipt = (
            await store.reserve({
              sourceId,
              mode: "apply",
              parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
              limit: 2,
            })
          ).find((receipt) => receipt.decisionId === secondId);
          if (secondReceipt === undefined) {
            panic("Missing adjacent completion fixture receipt");
          }
          expect(await store.pickup(secondReceipt.id)).toBe("ready");
          const payload = candidate.sourceRaw;
          if (payload === undefined) {
            panic("Canonical fixture has no raw envelope");
          }
          await store.markFetched({
            id: secondReceipt.id,
            payload,
            payloadHash: new Bun.CryptoHasher("sha256")
              .update(payload)
              .digest("hex"),
            claimedFingerprint: ecjCompletionFingerprint({
              existing: secondRow,
              judges: [],
            }),
            target: "full",
            provenance: { requestHashes: [], requestedSurfaces: [] },
          });
          process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"] = "2";
          const crawlTokens: string[] = [];
          let completedDocuments = 0;
          await withPublisher({
            respond: successfulPublisher,
            run: async (sent) => {
              const report = await runEuCompletionTickFixture(
                AbortSignal.timeout(20_000),
                {
                  healthConfig: { busyWindows: [] },
                  afterDocument: async () => {
                    completedDocuments++;
                    if (completedDocuments !== 1) {
                      return;
                    }
                    expect(
                      (await store.getReceipt(secondReceipt.id))?.writtenAt,
                    ).toBeNull();
                    const crawl = await acquireCaseLawSourceIngestionLease({
                      scopedDb: createIngestionDb(markRlsDatabase(db)),
                      sourceId,
                    });
                    if (crawl === null) {
                      panic(
                        "Completion retained the source lease between documents",
                      );
                    }
                    try {
                      crawlTokens.push(crawl.leaseToken);
                    } finally {
                      await crawl.release();
                    }
                  },
                },
              );
              expect(report).toMatchObject({
                status: "completed",
                attempted: 2,
                applied: 2,
                requests: 0,
              });
              expect(sent).toHaveLength(0);
            },
          });
          expect(crawlTokens).toHaveLength(1);
          expect(completedDocuments).toBe(2);
        } finally {
          storage.stop();
        }
      });
    }, 30_000);

    test("restart finalizes a committed canonical write after switch-off without applying it again", async () => {
      await withSource(async (sourceId) => {
        const storage = startCompletionFixtureStorage();
        try {
          const { store, receipt, row, candidate } =
            await fetchedApprovedFixture(sourceId);
          const ingestionDb = createIngestionDb(markRlsDatabase(db));
          const lease = await acquireCaseLawSourceIngestionLease({
            scopedDb: ingestionDb,
            sourceId,
          });
          if (lease === null) {
            panic("Fixture failed to acquire canonical writer lease");
          }
          const signal = AbortSignal.timeout(20_000);
          try {
            const observationOrder = await allocateSourceObservationOrder({
              scopedDb: ingestionDb,
              sourceId,
              leaseToken: lease.leaseToken,
            });
            const writer = createIngestionDb(markRlsDatabase(db), {
              maintenance: {
                before: async (tx) => {
                  expect(await store.assertApprovalTx(tx, receipt)).toBe(true);
                  expect(
                    await store.assertFetchedTx(tx, receipt.id),
                  ).not.toBeNull();
                },
                after: async (tx) => {
                  const written = (
                    await tx
                      .select({
                        hash: caseLawDecisions.sourceHash,
                        order: caseLawDecisions.sourceObservationOrder,
                      })
                      .from(caseLawDecisions)
                      .where(eq(caseLawDecisions.id, row.id))
                  ).at(0);
                  if (
                    written?.hash !== candidate.rawHash ||
                    written.order !== observationOrder
                  ) {
                    return;
                  }
                  await store.markWrittenTx(tx, {
                    id: receipt.id,
                    decisionId: row.id,
                  });
                  process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"] = "true";
                },
              },
            });
            await processDecision({
              input: candidate,
              sourceId,
              scopedDb: writer,
              sourceLease: lease,
              signal,
              s3Policy: { mode: "replay-strict", signal },
              observedAt: new Date(),
              observationOrder,
              refresh: DECISION_REFRESH.ALWAYS,
            });
          } finally {
            await lease.release();
          }
          const committed = (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, row.id))
          ).at(0);
          const marked = await store.getReceipt(receipt.id);
          expect(marked?.status).toBe("fetched");
          expect(marked?.writtenAt).not.toBeNull();
          const versions = [...storage.versions.entries()];
          const puts = storage.requests.filter(
            (request) => request.method === "PUT",
          ).length;
          expect(
            (
              await runEuCompletionTickFixture(AbortSignal.timeout(20_000), {
                healthConfig: { busyWindows: [] },
              })
            ).status,
          ).toBe("off");
          process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"] = "false";
          await withPublisher({
            respond: successfulPublisher,
            run: async (sent) => {
              const report = await runEuCompletionTickFixture(
                AbortSignal.timeout(20_000),
                { healthConfig: { busyWindows: [] } },
              );
              expect(report).toMatchObject({
                status: "completed",
                applied: 1,
                requests: 0,
              });
              expect(sent).toHaveLength(0);
            },
          });
          expect((await store.getReceipt(receipt.id))?.status).toBe("applied");
          expect(
            (
              await db
                .select()
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.id, row.id))
            ).at(0),
          ).toEqual(committed);
          expect([...storage.versions.entries()]).toEqual(versions);
          expect(
            storage.requests.filter((request) => request.method === "PUT"),
          ).toHaveLength(puts);
        } finally {
          storage.stop();
        }
      });
    }, 30_000);

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
        const store = createEuCompletionStore({
          db,
          now: () => Temporal.Now.instant().epochMilliseconds,
        });
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
        const store = createEuCompletionStore({
          db,
          now: () => Temporal.Now.instant().epochMilliseconds,
        });
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
