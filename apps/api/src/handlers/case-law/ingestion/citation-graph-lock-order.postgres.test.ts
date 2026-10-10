import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql, type SQLWrapper } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE,
  caseLawDecisionIdentifierBackfills,
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  runCitationGraphTransaction,
  tryCitationGraphTransaction,
} from "@/api/handlers/case-law/citation-graph-transaction";
import { createSafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { openRawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  withInterleaving,
  type InterleavingToken,
} from "@/api/tests/helpers/transaction-interleaving";

import { citationKeyOf } from "./citation-extractor";
import {
  DECISION_IDENTIFIER_BACKFILL_VERSION,
  runDecisionIdentifierBackfill,
} from "./decision-identifier-backfill";
import { processDecision } from "./pipeline/decision";
import { classifyObservation } from "./pipeline/decision-existing";
import {
  observeDecision,
  resolveDecisionIdentityTx,
} from "./pipeline/decision-identity";
import { planDecisionWrite } from "./pipeline/decision-plan";
import { writeDecisionRowWithSlug } from "./pipeline/decision-row";
import type { DecisionRowWrite } from "./pipeline/decision-row-context";
import {
  CASE_LAW_JUDGE_DEPENDENCIES,
  type CaseLawCorpusDependencies,
} from "./pipeline/dependencies";
import { sourceContractForAdapter } from "./pipeline/source-contract";
import { DECISION_REFRESH, DECISION_ROW_WRITE_STATUS } from "./pipeline/types";
import type { DecisionRowWriteStatus } from "./pipeline/types";
import { absorbStandaloneSupplementRow } from "./supplement-absorption";

const databaseUrl = process.env["DATABASE_URL"];
const enabled =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" && Boolean(databaseUrl);
const corpus = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => panic("Postgres fixture must not upload"),
  },
} satisfies CaseLawCorpusDependencies;

// This control intentionally uses the pre-owner primitives. No application
// mutation does so: it proves PostgreSQL detects the opposite lock order.
const oldGraphLock = sql`SELECT pg_advisory_xact_lock(hashtext('case_law'), hashtext('citation_resolution_walk'))`;

if (!databaseUrl || !enabled) {
  describe.skip("citation graph lock order (postgres)", () => {
    test("requires the gated PostgreSQL runner", () => {});
  });
} else {
  const withFixture = async <T>(
    run: (fixture: {
      scopedDb: ScopedDb;
      rootDb: CaseLawRootHandle;
      setPhase: (
        phase: (typeof CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE)[keyof typeof CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE],
      ) => Promise<void>;
      participant: (tx: Transaction) => ScopedDb;
      reset: () => Promise<void>;
      refresh: () => DecisionRowWrite;
      sourceId: ReturnType<typeof createSafeId<"caseLawSource">>;
      standaloneId: () => ReturnType<typeof createSafeId<"caseLawDecision">>;
      judgmentId: () => ReturnType<typeof createSafeId<"caseLawDecision">>;
      readState: () => Promise<{
        key: string | null;
        order: bigint | null;
        identifiers: number;
        citations: number;
      }>;
      trace: { query: string; at: number }[];
    }) => Promise<T>,
  ) =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const trace: { query: string; at: number }[] = [];
      const { db } = openClient({
        max: 1,
        logger: {
          logQuery: (query) => {
            trace.push({ query, at: performance.now() });
          },
        },
      });
      const schemaName = `graph_order_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        // Clone the corpus tables so production helpers cannot escape through
        // the global backfill checkpoint or a projection/identity side table.
        const tables = await db
          .select({ name: sql<string>`tablename` })
          .from(sql`pg_tables`)
          .where(
            sql`schemaname = 'public' AND (tablename LIKE 'case_law_%' OR tablename LIKE 'corpus_%')`,
          );
        for (const { name } of tables) {
          // db-await-in-loop: schema fixture creation is ordered before its use
          await db.execute(
            sql`CREATE TABLE ${schema}.${sql.identifier(name)} (LIKE public.${sql.identifier(name)} INCLUDING ALL)`,
          );
        }
        const identifierPrimaryKey = async (namespace: string) => {
          const constraints = await db
            .select({
              name: sql<string>`c.conname`,
              columns: sql<
                string[]
              >`array_agg(a.attname::text ORDER BY pk_key.ordinality)`,
            })
            .from(sql`pg_constraint AS c
              JOIN pg_class AS t ON t.oid = c.conrelid
              JOIN pg_namespace AS n ON n.oid = t.relnamespace
              CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS pk_key(attnum, ordinality)
              JOIN pg_attribute AS a ON a.attrelid = t.oid AND a.attnum = pk_key.attnum`)
            .where(sql`n.nspname = ${namespace}
              AND t.relname = 'case_law_decision_identifiers' AND c.contype = 'p'`)
            .groupBy(sql`c.conname`);
          expect(constraints).toHaveLength(1);
          const [constraint] = constraints;
          if (constraint === undefined) {
            throw new Error("Identifier fixture requires its primary key");
          }
          expect(constraint.columns).toEqual([
            "decision_id",
            "type",
            "normalized_value",
          ]);
          return constraint;
        };
        const productionPrimaryKey = await identifierPrimaryKey("public");
        expect(productionPrimaryKey.name).toBe(
          "case_law_decision_identifiers_pk",
        );
        const clonedPrimaryKey = await identifierPrimaryKey(schemaName);
        // LIKE copies the key with a generated name. Production conflict
        // clauses name it explicitly, so retain the key and align its name.
        await db.execute(sql`ALTER TABLE ${schema}.case_law_decision_identifiers
          RENAME CONSTRAINT ${sql.identifier(clonedPrimaryKey.name)} TO ${sql.identifier(productionPrimaryKey.name)}`);
        expect(await identifierPrimaryKey(schemaName)).toEqual(
          productionPrimaryKey,
        );
        await db.execute(
          sql`ALTER TABLE ${schema}.case_law_citations ADD FOREIGN KEY (citing_decision_id) REFERENCES ${schema}.case_law_decisions(id), ADD FOREIGN KEY (cited_decision_id) REFERENCES ${schema}.case_law_decisions(id)`,
        );
        await db.execute(
          sql`ALTER TABLE ${schema}.case_law_decision_identifiers ADD FOREIGN KEY (decision_id) REFERENCES ${schema}.case_law_decisions(id)`,
        );
        const configure = async (tx: Transaction) => {
          await tx.execute(
            sql`SELECT set_config('search_path', ${`${schemaName}, public`}, true)`,
          );
        };
        const scopedDb: ScopedDb = async (callback) =>
          await db.transaction(async (tx) => {
            await configure(tx);
            return await callback(tx);
          });
        // The harness has begun the transaction only to identify its backend.
        // Its identity SELECT locks no domain row; the real entry point still
        // acquires the graph before the first application row lock.
        const participant =
          (tx: Transaction): ScopedDb =>
          async (callback) => {
            await configure(tx);
            return await callback(tx);
          };
        const sourceId = createSafeId<"caseLawSource">();
        let prepared: DecisionRowWrite | undefined;
        let standalone = createSafeId<"caseLawDecision">();
        let judgment = createSafeId<"caseLawDecision">();
        const input = (sourceDocumentId: string, rawHash: string) =>
          plainTextIngestionResult({
            caseNumber: "21 Cdo 5/2019",
            court: "Nejvyšší soud",
            country: "CZE",
            language: "cs",
            sourceDocumentId,
            decisionDate: "2026-01-01",
            metadata: {},
            rawHash,
            textFields: absentDecisionTextFields(
              TEXT_ABSENCE_REASON.NOT_PUBLISHED,
            ),
            fulltext: rawHash.startsWith("b")
              ? "Podle rozhodnutí sp. zn. 7 Cdo 9/2019 a sp. zn. 30 Cdo 8/2024 je závěr shodný."
              : "Podle rozhodnutí sp. zn. 7 Cdo 9/2019 je závěr shodný.",
            sections: [
              {
                index: 0,
                type: "argumentation",
                title: null,
                text: rawHash.startsWith("b")
                  ? "Podle rozhodnutí sp. zn. 7 Cdo 9/2019 a sp. zn. 30 Cdo 8/2024 je závěr shodný."
                  : "Podle rozhodnutí sp. zn. 7 Cdo 9/2019 je závěr shodný.",
              },
            ],
            documentAst: {},
          });
        const reset = async () => {
          await scopedDb(async (tx) => {
            for (const { name } of tables) {
              // db-await-in-loop: all fixture tables are cleared before reseeding
              await tx.execute(
                sql`TRUNCATE ${schema}.${sql.identifier(name)} CASCADE`,
              );
            }
            await tx
              .insert(caseLawSources)
              .values({ id: sourceId, adapterKey: "cz-ns", name: "fixture" });
          });
          for (const document of ["judgment", "standalone"]) {
            // db-await-in-loop: seed production writes commit before the actors start
            const seeded = await processDecision({
              input: input(document, "a".repeat(64)),
              observationOrder: 1n,
              sourceId,
              scopedDb,
              observedAt: new Date("2026-01-01"),
              refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
              corpus,
            });
            expect(seeded.status).toBe("complete");
          }
          const observed = observeDecision({
            input: input("standalone", "b".repeat(64)),
            sourceId,
          });
          const identity = await scopedDb(
            async (tx) =>
              await resolveDecisionIdentityTx(tx, {
                ...observed,
                sourceId,
                statedEcliIdentity:
                  sourceContractForAdapter("cz-ns").statedEcliIdentity,
                proposedDecisionId: createSafeId<"caseLawDecision">(),
              }),
          );
          if (!identity.existing) {
            panic("Refresh fixture must already exist");
          }
          standalone = identity.existing.id;
          const target = await scopedDb(
            async (tx) =>
              await tx
                .select({ id: caseLawDecisions.id })
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.sourceDocumentId, "judgment")),
          );
          judgment = target.at(0)?.id ?? panic("Judgment fixture absent");
          const plan = (
            await planDecisionWrite({
              result: observed.observed,
              existing: identity.existing,
              decisionId: standalone,
              sourceId,
              scopedDb,
              corpus,
              incomingCarriesDocument: true,
              polarityRules: undefined,
            })
          ).unwrap();
          if ("status" in plan) {
            panic("Refresh must produce a write plan");
          }
          prepared = {
            ...identity,
            decisionId: standalone,
            sourceId,
            result: observed.observed,
            persistedDecisionDate: observed.persistedDecisionDate,
            composedSupplements: [],
            observedAt: new Date("2026-01-02"),
            observationOrder: 2n,
            shape: classifyObservation({
              result: observed.observed,
              existing: identity.existing,
            }),
            plan,
            rawArtifact: {
              s3UploadFailed: false,
              sourceRawContentType: null,
              sourceRawS3Key: null,
            },
            rawWrites: { attempted: false, window: openRawSourceWriteWindow() },
            judges: CASE_LAW_JUDGE_DEPENDENCIES,
          };
          await scopedDb(async (tx) => {
            await tx
              .delete(caseLawDecisionIdentifiers)
              .where(
                inArray(caseLawDecisionIdentifiers.decisionId, [
                  standalone,
                  judgment,
                ]),
              );
          });
          trace.length = 0;
        };
        const rootDb: CaseLawRootHandle = {
          transaction: scopedDb,
          execute: async <TRow extends Record<string, unknown>>(
            query: SQLWrapper | string,
          ) => await scopedDb(async (tx) => await tx.execute<TRow>(query)),
        };
        return await run({
          scopedDb,
          rootDb,
          setPhase: async (phase) => {
            await scopedDb(async (tx) => {
              await tx
                .update(caseLawDecisionIdentifierBackfills)
                .set({
                  phase,
                  cursorId: null,
                  completedAt:
                    phase ===
                    CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE
                      ? new Date()
                      : null,
                })
                .where(
                  eq(
                    caseLawDecisionIdentifierBackfills.version,
                    DECISION_IDENTIFIER_BACKFILL_VERSION,
                  ),
                );
            });
          },
          participant,
          reset,
          refresh: () => prepared ?? panic("Fixture not prepared"),
          sourceId,
          standaloneId: () => standalone,
          judgmentId: () => judgment,
          trace,
          readState: async () =>
            await scopedDb(async (tx) => {
              const row =
                (
                  await tx
                    .select({
                      key: caseLawDecisions.citationKey,
                      order: caseLawDecisions.sourceObservationOrder,
                    })
                    .from(caseLawDecisions)
                    .where(eq(caseLawDecisions.id, standalone))
                ).at(0) ?? panic("Refresh row absent");
              const identifiers = await tx
                .select({ type: caseLawDecisionIdentifiers.type })
                .from(caseLawDecisionIdentifiers)
                .where(eq(caseLawDecisionIdentifiers.decisionId, standalone));
              const citations = await tx
                .select({ id: caseLawCitations.id })
                .from(caseLawCitations)
                .where(eq(caseLawCitations.citingDecisionId, standalone));
              return {
                ...row,
                identifiers: identifiers.length,
                citations: citations.length,
              };
            }),
        });
      } finally {
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });

  describe("citation graph lock order (postgres)", () => {
    for (const competitor of ["absorption", "backfill"] as const) {
      for (const rowFirstControl of [false, true]) {
        test(
          rowFirstControl
            ? `row-first refresh control deadlocks with actual ${competitor}`
            : `refresh and ${competitor} commit in every interleaving`,
          async () =>
            await withFixture(async (fixture) => {
              const results = await withInterleaving({
                databaseUrl,
                reset: fixture.reset,
                readState: fixture.readState,
                a: {
                  steps: [
                    {
                      name: "refresh",
                      run: async (tx) => {
                        const participant = fixture.participant(tx);
                        const scoped: ScopedDb = rowFirstControl
                          ? async (callback) =>
                              await participant(async (local) => {
                                // Move the decision row ahead of the real owner
                                // while retaining the actual refresh operation.
                                await local.execute(
                                  sql`SELECT id FROM ${caseLawDecisions} WHERE id = ${fixture.standaloneId()} FOR UPDATE`,
                                );
                                return await callback(local);
                              })
                          : participant;
                        const written = await writeDecisionRowWithSlug(
                          scoped,
                          fixture.refresh(),
                        );
                        if (written.isErr()) {
                          throw written.error;
                        }
                        const allowedStatuses: readonly DecisionRowWriteStatus[] =
                          [
                            DECISION_ROW_WRITE_STATUS.APPLIED,
                            DECISION_ROW_WRITE_STATUS.WINNER_SETTLED,
                            DECISION_ROW_WRITE_STATUS.STALE_PAYLOAD,
                          ];
                        expect(allowedStatuses).toContain(written.value);
                      },
                    },
                  ],
                },
                b: {
                  steps: [
                    {
                      name: "admit-graph",
                      run: async (tx) => {
                        // Keep the actual owner's transaction lock through the
                        // next operation and the separately scheduled commit.
                        await runCitationGraphTransaction(
                          fixture.participant(tx),
                          async () => undefined,
                        );
                      },
                    },
                    {
                      name: competitor,
                      run: async (tx) => {
                        const scoped = fixture.participant(tx);
                        if (competitor === "absorption") {
                          const absorbed = await absorbStandaloneSupplementRow({
                            scopedDb: scoped,
                            sourceId: fixture.sourceId,
                            kind: "reasons",
                            sourceDocumentId: "standalone",
                            judgmentId: fixture.judgmentId(),
                            observationOrder: 3n,
                            withdraw: async () =>
                              Result.ok({ type: "withdrawn" }),
                            eraseRaw: async () => Result.ok(undefined),
                          });
                          if (absorbed.isErr()) {
                            throw absorbed.error;
                          }
                          expect(absorbed.value.type).toBe("absorbed");
                        } else {
                          const backfill = await runDecisionIdentifierBackfill(
                            {
                              execute: tx.execute.bind(tx),
                              transaction: scoped,
                            },
                            { batchSize: 10 },
                          );
                          expect(backfill.status).toBe("complete");
                        }
                      },
                    },
                  ],
                },
                ...(rowFirstControl
                  ? {
                      schedules: [
                        [
                          "b.admit-graph",
                          "a.refresh",
                          `b.${competitor}`,
                          "a.commit",
                          "b.commit",
                        ] satisfies InterleavingToken[],
                      ],
                    }
                  : {}),
                invariant: ({ outcomes, state }) => {
                  if (rowFirstControl) {
                    expect(
                      Object.values(outcomes).filter(
                        ({ status }) => status === "deadlock",
                      ),
                    ).toHaveLength(1);
                    expect(
                      Object.values(outcomes).filter(
                        ({ status }) => status === "committed",
                      ),
                    ).toHaveLength(1);
                    return;
                  }
                  expect(outcomes).toEqual({
                    a: { status: "committed" },
                    b: { status: "committed" },
                  });
                  if (competitor === "absorption") {
                    expect(state).toEqual({
                      key: null,
                      order: 3n,
                      identifiers: 0,
                      citations: 0,
                    });
                  } else {
                    expect(state.key).toBe(citationKeyOf("21 Cdo 5/2019"));
                    expect(state.order).toBe(2n);
                    expect(state.identifiers).toBeGreaterThan(0);
                    expect(state.citations).toBeGreaterThan(0);
                  }
                },
                timeoutMs: 15_000,
              });
              expect(results).toHaveLength(rowFirstControl ? 1 : 10);
              expect(results.some(({ blocked }) => blocked.length > 0)).toBe(
                true,
              );
            }),
          120_000,
        );
      }
    }

    for (const phase of [
      CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS,
      CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_CITATIONS,
      CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE,
    ]) {
      test(
        `backfill ${phase} completes while another transaction holds the graph`,
        async () =>
          await withFixture(async (fixture) => {
            const results = await withInterleaving({
              databaseUrl,
              reset: async () => {
                await fixture.reset();
                expect(
                  (
                    await runDecisionIdentifierBackfill(fixture.rootDb, {
                      batchSize: 10,
                    })
                  ).status,
                ).toBe("complete");
                await fixture.setPhase(phase);
              },
              readState: fixture.readState,
              a: {
                steps: [
                  {
                    name: "graph",
                    run: async (tx) =>
                      await runCitationGraphTransaction(
                        fixture.participant(tx),
                        async () => undefined,
                      ),
                  },
                ],
              },
              b: {
                steps: [
                  {
                    name: "verify",
                    run: async (tx) => {
                      await fixture.participant(tx)(async () => undefined);
                      const result = await runDecisionIdentifierBackfill(
                        {
                          execute: tx.execute.bind(tx),
                          transaction: fixture.participant(tx),
                        },
                        { batchSize: 10 },
                      );
                      expect(result.status).toBe("complete");
                    },
                  },
                ],
              },
              schedules: [["a.graph", "b.verify", "a.commit", "b.commit"]],
              invariant: ({ outcomes, blocked }) => {
                expect(outcomes).toEqual({
                  a: { status: "committed" },
                  b: { status: "committed" },
                });
                expect(blocked).not.toContain("b.verify");
              },
              timeoutMs: 15_000,
            });
            expect(results).toHaveLength(1);
          }),
        60_000,
      );
    }

    for (const phase of [
      CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS,
      CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
    ]) {
      test(
        `backfill ${phase} owns the graph before waiting for its checkpoint`,
        async () =>
          await withFixture(async (fixture) => {
            const results = await withInterleaving({
              databaseUrl,
              reset: async () => {
                await fixture.reset();
                expect(
                  (
                    await runDecisionIdentifierBackfill(fixture.rootDb, {
                      batchSize: 10,
                    })
                  ).status,
                ).toBe("complete");
                await fixture.setPhase(phase);
              },
              readState: fixture.readState,
              a: {
                steps: [
                  {
                    name: "checkpoint",
                    run: async (tx) =>
                      await fixture.participant(tx)(
                        async (local) =>
                          await local.execute(
                            sql`SELECT version FROM ${caseLawDecisionIdentifierBackfills} WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION} FOR UPDATE`,
                          ),
                      ),
                  },
                  {
                    name: "try-graph",
                    run: async (tx) => {
                      expect(
                        await tryCitationGraphTransaction(
                          fixture.participant(tx),
                          async () => "admitted",
                        ),
                      ).toBeNull();
                    },
                  },
                ],
              },
              b: {
                steps: [
                  {
                    name: "project",
                    run: async (tx) => {
                      await fixture.participant(tx)(async () => undefined);
                      expect(
                        (
                          await runDecisionIdentifierBackfill(
                            {
                              execute: tx.execute.bind(tx),
                              transaction: fixture.participant(tx),
                            },
                            { batchSize: 10 },
                          )
                        ).status,
                      ).toBe("complete");
                    },
                  },
                ],
              },
              schedules: [
                [
                  "a.checkpoint",
                  "b.project",
                  "a.try-graph",
                  "a.commit",
                  "b.commit",
                ],
              ],
              invariant: ({ outcomes, blocked }) => {
                expect(outcomes).toEqual({
                  a: { status: "committed" },
                  b: { status: "committed" },
                });
                expect(blocked).toContain("b.project");
              },
              timeoutMs: 15_000,
            });
            expect(results).toHaveLength(1);
          }),
        60_000,
      );
    }

    for (const [selectedPhase, changedPhase] of [
      [
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS,
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS,
      ],
      [
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS,
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS,
      ],
      [
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_CITATIONS,
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
      ],
      [
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_CITATIONS,
      ],
      [
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE,
        CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS,
      ],
    ] as const) {
      test(
        `a ${selectedPhase}-to-${changedPhase} phase race restarts before domain work`,
        async () =>
          await withFixture(async (fixture) => {
            await fixture.reset();
            expect(
              (
                await runDecisionIdentifierBackfill(fixture.rootDb, {
                  batchSize: 10,
                })
              ).status,
            ).toBe("complete");
            await fixture.setPhase(selectedPhase);
            fixture.trace.length = 0;
            const transactions: string[][] = [];
            let transactionCount = 0;
            const rootDb: CaseLawRootHandle = {
              execute: fixture.rootDb.execute,
              transaction: async (work) => {
                transactionCount += 1;
                // Initial read, then unlocked page selection, then its locked recheck.
                if (transactionCount === 3) {
                  await fixture.setPhase(changedPhase);
                }
                return await fixture.scopedDb(async (tx) => {
                  const from = fixture.trace.length;
                  const value = await work(tx);
                  transactions.push(
                    fixture.trace.slice(from).map(({ query }) => query),
                  );
                  return value;
                });
              },
            };
            const interruption = new Error("first projection committed");
            const result = await Result.tryPromise({
              try: async () =>
                await runDecisionIdentifierBackfill(rootDb, {
                  batchSize: 10,
                  onProgress: (progress) => {
                    if (progress.type === "page") {
                      expect(progress.progress.phase).toBe(changedPhase);
                      throw interruption;
                    }
                  },
                }),
              catch: (error: unknown) => error,
            });
            expect(result.isErr()).toBe(true);
            if (result.isOk()) {
              panic("Expected committed projection interruption");
            }
            expect(result.error).toBe(interruption);
            const plainRecheck =
              transactions.at(2) ?? panic("Phase recheck absent");
            expect(
              plainRecheck.some((query) => query.includes("FOR UPDATE")),
            ).toBe(true);
            expect(
              plainRecheck.some((query) => query.includes("pg_advisory")),
            ).toBe(
              selectedPhase ===
                CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS ||
                selectedPhase ===
                  CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
            );
            expect(
              plainRecheck.every(
                (query) =>
                  query.includes("case_law_decision_identifier_backfills") ||
                  query.includes("pg_advisory_xact_lock"),
              ),
            ).toBe(true);
            // Two page attempts plus the initial read: no intervening verification scan.
            expect(transactions).toHaveLength(5);
            const resumed = transactions.at(4) ?? panic("Resumed page absent");
            const graphIndex = resumed.findIndex((query) =>
              query.includes("pg_advisory_xact_lock"),
            );
            const writing =
              changedPhase ===
                CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS ||
              changedPhase ===
                CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS;
            expect(graphIndex !== -1).toBe(writing);
            if (writing) {
              const checkpointIndex = resumed.findIndex(
                (query) =>
                  query.includes("case_law_decision_identifier_backfills") &&
                  query.includes("FOR UPDATE"),
              );
              expect(checkpointIndex).toBeGreaterThan(graphIndex);
            }
          }),
        60_000,
      );
    }

    test(
      "consecutive phase races stop within their own budget without full verification",
      async () =>
        await withFixture(async (fixture) => {
          await fixture.reset();
          expect(
            (
              await runDecisionIdentifierBackfill(fixture.rootDb, {
                batchSize: 10,
              })
            ).status,
          ).toBe("complete");
          await fixture.setPhase(
            CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS,
          );
          fixture.trace.length = 0;
          let transactionCount = 0;
          let changes = 0;
          const rootDb: CaseLawRootHandle = {
            execute: fixture.rootDb.execute,
            transaction: async (work) => {
              transactionCount += 1;
              if (transactionCount >= 3 && transactionCount % 2 === 1) {
                changes += 1;
                await fixture.setPhase(
                  changes % 2 === 1
                    ? CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS
                    : CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS,
                );
              }
              return await fixture.scopedDb(work);
            },
          };
          const result = await Result.tryPromise({
            try: async () =>
              await runDecisionIdentifierBackfill(rootDb, {
                batchSize: 10,
                onProgress: () =>
                  panic(
                    "A raced page must not report repair or projection progress",
                  ),
              }),
            catch: (error: unknown) => error,
          });
          expect(result.isErr()).toBe(true);
          if (result.isOk()) {
            panic("Expected bounded phase race refusal");
          }
          expect(result.error).toMatchObject({
            message:
              "Decision identifier backfill phase changed without progress after 3 retries",
          });
          expect(changes).toBe(4);
          expect(transactionCount).toBe(9);
          expect(
            fixture.trace.every(
              ({ query }) =>
                query.includes("case_law_decision_identifier_backfills") ||
                query.includes("pg_advisory_xact_lock") ||
                query.includes("set_config") ||
                /^(?:begin|commit)/iu.test(query.trim()),
            ),
          ).toBe(true);
        }),
      60_000,
    );

    test(
      "committed progress resets the consecutive phase-race budget",
      async () =>
        await withFixture(async (fixture) => {
          await fixture.reset();
          expect(
            (
              await runDecisionIdentifierBackfill(fixture.rootDb, {
                batchSize: 10,
              })
            ).status,
          ).toBe("complete");
          await fixture.setPhase(
            CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS,
          );
          let transactionCount = 0;
          let rechecks = 0;
          let changes = 0;
          let pages = 0;
          const interruption = new Error("second page committed");
          const rootDb: CaseLawRootHandle = {
            execute: fixture.rootDb.execute,
            transaction: async (work) => {
              transactionCount += 1;
              if (transactionCount >= 3 && transactionCount % 2 === 1) {
                rechecks += 1;
                if (rechecks !== 4 && changes < 6) {
                  changes += 1;
                  await fixture.setPhase(
                    changes % 2 === 1
                      ? CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS
                      : CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS,
                  );
                }
              }
              return await fixture.scopedDb(work);
            },
          };
          const result = await Result.tryPromise({
            try: async () =>
              await runDecisionIdentifierBackfill(rootDb, {
                batchSize: 1,
                onProgress: (progress) => {
                  expect(progress.type).toBe("page");
                  pages += 1;
                  if (pages === 2) {
                    throw interruption;
                  }
                },
              }),
            catch: (error: unknown) => error,
          });
          expect(result.isErr()).toBe(true);
          if (result.isOk()) {
            panic("Expected second committed page interruption");
          }
          expect(result.error).toBe(interruption);
          expect(pages).toBe(2);
          expect(changes).toBe(6);
          expect(transactionCount).toBe(17);
        }),
      60_000,
    );

    for (const newerPhase of [
      CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
      CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE,
    ]) {
      test(
        `a stale completion cannot reset the newer ${newerPhase} checkpoint`,
        async () =>
          await withFixture(async (fixture) => {
            await fixture.reset();
            expect(
              (
                await runDecisionIdentifierBackfill(fixture.rootDb, {
                  batchSize: 10,
                })
              ).status,
            ).toBe("complete");
            await fixture.scopedDb(async (tx) => {
              await tx
                .delete(caseLawDecisionIdentifiers)
                .where(
                  eq(
                    caseLawDecisionIdentifiers.decisionId,
                    fixture.standaloneId(),
                  ),
                );
            });
            let retryReported = false;
            let restartQueries: string[] = [];
            const interruption = new Error("restart guard committed");
            const rootDb: CaseLawRootHandle = {
              execute: fixture.rootDb.execute,
              transaction: async (work) => {
                const inject = retryReported;
                if (inject) {
                  await fixture.setPhase(newerPhase);
                  if (
                    newerPhase ===
                    CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE
                  ) {
                    await fixture.scopedDb(async (tx) => {
                      await tx
                        .update(caseLawDecisionIdentifierBackfills)
                        .set({ completedAt: new Date("2099-01-01") })
                        .where(
                          eq(
                            caseLawDecisionIdentifierBackfills.version,
                            DECISION_IDENTIFIER_BACKFILL_VERSION,
                          ),
                        );
                    });
                  }
                }
                const value = await fixture.scopedDb(async (tx) => {
                  const from = fixture.trace.length;
                  const result = await work(tx);
                  if (inject) {
                    restartQueries = fixture.trace
                      .slice(from)
                      .map(({ query }) => query);
                  }
                  return result;
                });
                if (inject) {
                  throw interruption;
                }
                return value;
              },
            };
            const result = await Result.tryPromise({
              try: async () =>
                await runDecisionIdentifierBackfill(rootDb, {
                  batchSize: 10,
                  onProgress: (progress) => {
                    expect(progress.type).toBe("retry");
                    retryReported = true;
                  },
                }),
              catch: (error: unknown) => error,
            });
            expect(result.isErr()).toBe(true);
            if (result.isOk()) {
              panic("Expected committed restart guard interruption");
            }
            expect(result.error).toBe(interruption);
            expect(
              restartQueries.some((query) => query.includes("FOR UPDATE")),
            ).toBe(true);
            expect(
              restartQueries.some((query) => /^update/iu.test(query.trim())),
            ).toBe(false);
            const checkpoint = await fixture.scopedDb(async (tx) =>
              (
                await tx
                  .select()
                  .from(caseLawDecisionIdentifierBackfills)
                  .where(
                    eq(
                      caseLawDecisionIdentifierBackfills.version,
                      DECISION_IDENTIFIER_BACKFILL_VERSION,
                    ),
                  )
              ).at(0),
            );
            expect(checkpoint?.phase).toBe(newerPhase);
            if (
              newerPhase ===
              CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE
            ) {
              expect(checkpoint?.completedAt).toEqual(new Date("2099-01-01"));
            }
          }),
        60_000,
      );
    }

    test(
      "the opposite decision-row and graph order produces a real deadlock",
      async () =>
        await withFixture(async (fixture) => {
          const results = await withInterleaving({
            databaseUrl,
            reset: fixture.reset,
            readState: fixture.readState,
            a: {
              steps: [
                {
                  name: "row",
                  run: async (tx) => {
                    await fixture.participant(tx)(
                      async (local) =>
                        await local.execute(
                          sql`SELECT id FROM ${caseLawDecisions} WHERE id = ${fixture.standaloneId()} FOR UPDATE`,
                        ),
                    );
                  },
                },
                {
                  name: "graph",
                  run: async (tx) => await tx.execute(oldGraphLock),
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "graph",
                  run: async (tx) => await tx.execute(oldGraphLock),
                },
                {
                  name: "row",
                  run: async (tx) => {
                    await fixture.participant(tx)(
                      async (local) =>
                        await local.execute(
                          sql`SELECT id FROM ${caseLawDecisions} WHERE id = ${fixture.standaloneId()} FOR UPDATE`,
                        ),
                    );
                  },
                },
              ],
            },
            schedules: [
              ["a.row", "b.graph", "a.graph", "b.row", "a.commit", "b.commit"],
            ],
            invariant: ({ outcomes }) => {
              expect(
                Object.values(outcomes).filter(
                  ({ status }) => status === "deadlock",
                ),
              ).toHaveLength(1);
              expect(
                Object.values(outcomes).filter(
                  ({ status }) => status === "committed",
                ),
              ).toHaveLength(1);
            },
            timeoutMs: 15_000,
          });
          expect(results.at(0)?.blocked.length).toBeGreaterThan(0);
        }),
      30_000,
    );

    test(
      "records the graph hold interval of a representative refresh",
      async () =>
        await withFixture(async (fixture) => {
          await fixture.reset();
          const started = performance.now();
          const written = await writeDecisionRowWithSlug(
            fixture.scopedDb,
            fixture.refresh(),
          );
          if (written.isErr()) {
            throw written.error;
          }
          const finished = performance.now();
          const graph =
            fixture.trace.find(
              ({ query }) =>
                query.includes("pg_advisory_xact_lock") &&
                query.includes("citation_resolution_walk"),
            ) ?? panic("Graph acquisition was not traced");
          const firstGraphMutation =
            fixture.trace.find(
              ({ query }) =>
                /^(?:update|delete|insert)/iu.test(query.trim()) &&
                query.includes("case_law_citations"),
            ) ?? panic("Citation mutation was not traced");
          // Query-start intervals are representative upper bounds; this is
          // a read-only duration observation, not a throughput assertion.
          console.info(
            JSON.stringify({
              message: "citation_graph_lock_measurement",
              transactionMs: finished - started,
              graphHoldUpperBoundMs: finished - graph.at,
              addedEarlyHoldUpperBoundMs: firstGraphMutation.at - graph.at,
              queries: fixture.trace.length,
            }),
          );
          expect(written.value).toBe(DECISION_ROW_WRITE_STATUS.APPLIED);
        }),
      30_000,
    );
  });
}
