import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import fc from "fast-check";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";

import { databaseRelations } from "@/api/db/database-relations";
import {
  caseLawDecisions,
  caseLawDecisionCitationStatsState,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSourceSqlFor } from "@/api/lib/case-law/redistribution-sql";
import { boundedAll } from "@/api/lib/db/bounded-all";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

import {
  CITATION_TIMELINE_MAX_YEARS,
  exactDecisionCitationSummaryQuery,
  EXACT_CITATION_SUMMARY_MAX_ROWS,
} from "./citation-graph";
import {
  compareDecisionCitationStats,
  reconcileDecisionCitationStats,
  refreshDecisionCitationStats,
} from "./citation-stats";

const databaseUrl = process.env["DATABASE_URL"];
const member = (values: readonly string[], index: number) =>
  values.at(index) ?? panic("Citation stats fixture index is out of bounds");
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// This oracle deliberately reads ordinary edges, never the contribution or recount
// functions. Its visibility predicate is emitted by the public reader's owner.
const compareProjection = async (client: SQL, ids: string[]) => {
  const expected = await client.unsafe(
    `
    WITH contributions AS (
      SELECT e.cited_decision_id AS decision_id, 'incoming' AS direction,
        coalesce(extract(year FROM d.decision_date)::integer, 0) AS related_year,
        d.country AS related_country, d.source_id AS related_source_id,
        coalesce(e.polarity, 'unknown') AS polarity
      FROM case_law_citations e JOIN case_law_decisions d ON d.id = e.citing_decision_id
      WHERE e.kind = 'precedent' AND e.cited_decision_id = ANY($1::uuid[])
        AND ${publishedCaseLawDecisionSqlFor("d")}
      UNION ALL
      SELECT e.citing_decision_id, 'outgoing', 0, d.country, d.source_id,
        coalesce(e.polarity, 'unknown')
      FROM case_law_citations e LEFT JOIN case_law_decisions d ON d.id = e.cited_decision_id
      WHERE e.kind = 'precedent' AND e.citing_decision_id = ANY($1::uuid[])
        AND (e.cited_decision_id IS NULL OR (${publishedCaseLawDecisionSqlFor("d")}))
    ) SELECT decision_id, direction, related_year, related_country, related_source_id,
      polarity, count(*)::text AS count FROM contributions
    GROUP BY decision_id, direction, related_year, related_country, related_source_id, polarity
    ORDER BY decision_id, direction, related_year, related_country, related_source_id, polarity
  `,
    [client.array(ids, "TEXT")],
  );
  const actual =
    await client`SELECT decision_id, direction, related_year, related_country,
    related_source_id, polarity, count::text AS count FROM case_law_decision_citation_stats
    WHERE decision_id = ANY(${client.array(ids, "TEXT")}::uuid[])
    ORDER BY decision_id, direction, related_year, related_country, related_source_id, polarity`;
  return { expected: [...expected], actual: [...actual] };
};

const compareFilteredSummary = async (client: SQL, ids: string[]) => {
  const currentYear = 2026;
  const firstYear = currentYear - (CITATION_TIMELINE_MAX_YEARS - 1);
  const expected = await client.unsafe(
    `
    WITH visible_edges AS (
      SELECT e.cited_decision_id AS decision_id, 'incoming' AS direction,
        CASE WHEN extract(year FROM d.decision_date) BETWEEN $3 AND $4
          THEN extract(year FROM d.decision_date)::integer END AS year,
        coalesce(e.polarity, 'unknown') AS polarity
      FROM case_law_citations e
      JOIN case_law_decisions d ON d.id = e.citing_decision_id
      JOIN case_law_sources source ON source.id = d.source_id
      WHERE e.kind = 'precedent' AND e.cited_decision_id = ANY($1::uuid[])
        AND ${publishedCaseLawDecisionSqlFor("d")}
        AND ${redistributableCaseLawSourceSqlFor("source")}
        AND d.country = ANY($2::text[])
      UNION ALL
      SELECT e.citing_decision_id, 'outgoing', NULL::integer, coalesce(e.polarity, 'unknown')
      FROM case_law_citations e
      LEFT JOIN case_law_decisions d ON d.id = e.cited_decision_id
      LEFT JOIN case_law_sources source ON source.id = d.source_id
      WHERE e.kind = 'precedent' AND e.citing_decision_id = ANY($1::uuid[])
        AND (e.cited_decision_id IS NULL OR (
          ${publishedCaseLawDecisionSqlFor("d")}
          AND ${redistributableCaseLawSourceSqlFor("source")}
          AND d.country = ANY($2::text[])))
    ) SELECT decision_id, direction, year, polarity,
        count(*)::double precision AS count, false AS capped
      FROM visible_edges GROUP BY decision_id, direction, year, polarity
  `,
    [
      client.array(ids, "TEXT"),
      client.array([...PUBLIC_CASE_LAW_COUNTRIES], "TEXT"),
      firstYear,
      currentYear,
    ],
  );
  const tx = drizzle({ client, relations: databaseRelations });
  const actual = [];
  for (const decisionId of ids) {
    const rows = await boundedAll({
      invariant: "citation direction/year grouping and stored polarity domain",
      max: EXACT_CITATION_SUMMARY_MAX_ROWS,
      table: "case_law_decision_citation_stats",
      query: (limit) =>
        exactDecisionCitationSummaryQuery({
          tx,
          decisionId: toSafeId<"caseLawDecision">(decisionId),
          currentYear,
          limit,
        }),
    });
    for (const row of rows) {
      actual.push({ decision_id: decisionId, ...row });
    }
  }
  const key = (row: {
    decision_id: string;
    direction: string;
    year: number | null;
    polarity: string | null;
  }) =>
    `${row.decision_id}|${row.direction}|${String(row.year)}|${String(row.polarity)}`;
  expect(actual.toSorted((a, b) => compareCodeUnit(key(a), key(b)))).toEqual(
    [...expected].toSorted((a, b) => compareCodeUnit(key(a), key(b))),
  );
};

type CitationStatsFixture = { client: SQL; ids: string[]; sources: string[] };
const withFixture = async (
  run: (fixture: CitationStatsFixture) => Promise<void>,
) => {
  if (!databaseUrl) {
    return;
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    await openClient().sql.begin(async (client) => {
      await client`SAVEPOINT citation_stats_fixture`;
      await client`SET LOCAL lock_timeout = '2s'`;
      await client`SET LOCAL statement_timeout = '5s'`;
      try {
        const db = drizzle({ client });
        const sources = [0, 1].map(() =>
          caseLawSourceRow({
            adapterKey: `citation-stats-${Bun.randomUUIDv7()}`,
          }),
        );
        await db.insert(caseLawSources).values(sources);
        const ids = [0, 1, 2, 3].map(() => createSafeId<"caseLawDecision">());
        for (const id of ids) {
          await db.insert(caseLawDecisions).values({
            id,
            sourceId:
              sources.at(0)?.id ??
              panic("Citation stats source fixture is empty"),
            country: "CZE",
            court: "Court",
            language: "cs",
            caseNumber: id,
            decisionDate: "2020-01-01",
            metadata: {},
          });
          await client`SELECT refresh_decision_citation_stats(${id}::uuid)`;
        }
        await run({ client, ids, sources: sources.map(({ id }) => id) });
      } finally {
        // Includes trigger DDL: mutations must never escape the transaction.
        await client`ROLLBACK TO SAVEPOINT citation_stats_fixture`;
      }
    });
  });
};

type InsertEdgeOptions = { citing: string; cited: string | null; id?: string };
const insertEdge = async (
  client: SQL,
  { citing, cited, id = Bun.randomUUIDv7() }: InsertEdgeOptions,
) => {
  await client`INSERT INTO case_law_citations (id, citing_decision_id, cited_decision_id, citation_text, kind)
    VALUES (${id}::uuid, ${citing}::uuid, ${cited}::uuid, ${id}, 'precedent')`;
  return id;
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("decision citation statistics (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("decision citation statistics (postgres)", () => {
    test("decision citation projections equal full recount after arbitrary graph transitions", async () => {
      await assertProperty(
        "decision citation projections equal full recount after arbitrary graph transitions",
        fc.asyncProperty(
          fc.array(
            fc.record({
              operation: fc.constantFrom(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
              node: fc.integer({ min: 0, max: 3 }),
              value: fc.integer({ min: 0, max: 6 }),
            }),
            { minLength: 15, maxLength: 35 },
          ),
          async (operations) => {
            await withFixture(async ({ client, ids, sources }) => {
              const edges = [
                await insertEdge(client, {
                  citing: member(ids, 0),
                  cited: member(ids, 1),
                }),
                await insertEdge(client, {
                  citing: member(ids, 1),
                  cited: member(ids, 2),
                }),
                await insertEdge(client, {
                  citing: member(ids, 2),
                  cited: null,
                }),
                await insertEdge(client, {
                  citing: member(ids, 3),
                  cited: member(ids, 3),
                }),
              ];
              const initial = await compareProjection(client, ids);
              expect(initial.actual).toEqual(initial.expected);
              await compareFilteredSummary(client, ids);
              for (const { operation, node, value } of operations) {
                const decision = member(ids, node);
                const edge = edges.at(value % Math.max(1, edges.length));
                switch (operation) {
                  case 0:
                    edges.push(
                      await insertEdge(client, {
                        citing: decision,
                        cited: value % 2 ? null : member(ids, (node + 1) % 4),
                      }),
                    );
                    break;
                  case 1:
                    if (edge) {
                      await client`DELETE FROM case_law_citations WHERE id = ${edge}::uuid`;
                      edges.splice(edges.indexOf(edge), 1);
                    }
                    break;
                  case 2:
                    if (edge) {
                      await client`UPDATE case_law_citations SET cited_decision_id = ${value % 2 ? null : decision}::uuid WHERE id = ${edge}::uuid`;
                    }
                    break;
                  case 3:
                    if (edge) {
                      await client`UPDATE case_law_citations SET citing_decision_id = ${decision}::uuid WHERE id = ${edge}::uuid`;
                    }
                    break;
                  case 4:
                    if (edge) {
                      await client`UPDATE case_law_citations SET kind = ${value % 2 ? "procedural" : "precedent"} WHERE id = ${edge}::uuid`;
                    }
                    break;
                  case 5:
                    if (edge) {
                      await client`UPDATE case_law_citations SET polarity = ${["positive", "negative", "neutral", "supportive", "mixed", "unknown", null].at(value) ?? null} WHERE id = ${edge}::uuid`;
                    }
                    break;
                  case 6:
                    await client`UPDATE case_law_decisions SET metadata = ${JSON.stringify(value % 2 ? { _stellaPartialObservation: { isListingOnly: true } } : {})}::text::jsonb WHERE id = ${decision}::uuid`;
                    break;
                  case 7:
                    await client`UPDATE case_law_decisions SET decision_date = ${[null, "1966-02-01", "1967-02-01", "2020-02-01", "2026-02-01", "2024-02-01", "2025-02-01"].at(value) ?? null}::date WHERE id = ${decision}::uuid`;
                    break;
                  case 8:
                    await client`UPDATE case_law_decisions SET country = ${value % 2 ? "USA" : "CZE"} WHERE id = ${decision}::uuid`;
                    break;
                  case 9:
                    await client`UPDATE case_law_decisions SET source_id = ${member(sources, value % 2)}::uuid WHERE id = ${decision}::uuid`;
                    break;
                  case 10: {
                    const beforePolicyChange = await compareProjection(
                      client,
                      ids,
                    );
                    await client`UPDATE case_law_sources SET descriptor = ${JSON.stringify({ license: "restricted", allowsDerivedAi: false, attribution: null, allowsRedistribution: value % 2 === 0 })}::text::jsonb WHERE id = ${member(sources, node % 2)}::uuid`;
                    const afterPolicyChange = await compareProjection(
                      client,
                      ids,
                    );
                    expect(afterPolicyChange.actual).toEqual(
                      beforePolicyChange.actual,
                    );
                    break;
                  }
                }
                const comparison = await compareProjection(client, ids);
                expect(comparison.actual).toEqual(comparison.expected);
                await compareFilteredSummary(client, ids);
              }
              // Force both deletion FK paths regardless of the generated trace.
              await insertEdge(client, {
                citing: member(ids, 0),
                cited: member(ids, 1),
              });
              await insertEdge(client, {
                citing: member(ids, 1),
                cited: member(ids, 2),
              });
              await client`DELETE FROM case_law_decisions WHERE id = ${member(ids, 1)}::uuid`;
              const comparison = await compareProjection(client, ids);
              expect(comparison.actual).toEqual(comparison.expected);
              await compareFilteredSummary(client, ids);
            });
          },
        ),
        { numRuns: 12 },
      );
    }, 60_000);

    test("comparison reports drift without writing and repair restores exact independently recounted buckets", async () => {
      await withFixture(async ({ client, ids }) => {
        const tx = drizzle({ client });
        const decisionIds = ids.map((id) => toSafeId<"caseLawDecision">(id));
        await insertEdge(client, {
          citing: member(ids, 0),
          cited: member(ids, 1),
        });
        await client`UPDATE case_law_decision_citation_stats SET count = count + 7 WHERE decision_id = ${member(ids, 1)}::uuid`;
        const corrupted = await compareProjection(client, ids);
        expect(corrupted.actual).not.toEqual(corrupted.expected);
        const comparison = await compareDecisionCitationStats({
          tx,
          decisionIds,
        });
        expect(
          comparison.find(({ decisionId }) => decisionId === member(ids, 1)),
        ).toMatchObject({ status: "drift", mismatchedBuckets: 2 });
        expect(
          await reconcileDecisionCitationStats({
            tx,
            decisionIds,
            mode: "compare",
          }),
        ).toEqual(comparison);
        const afterCompare = await compareProjection(client, ids);
        expect(afterCompare.actual).toEqual(corrupted.actual);
        expect(
          await reconcileDecisionCitationStats({
            tx,
            decisionIds,
            mode: "repair",
          }),
        ).toEqual(comparison);
        const repaired = await compareProjection(client, ids);
        expect(repaired.actual).toEqual(repaired.expected);
        expect(
          (await compareDecisionCitationStats({ tx, decisionIds })).map(
            ({ status }) => status,
          ),
        ).toEqual(ids.map(() => "consistent"));
        const states = await tx
          .select({ status: caseLawDecisionCitationStatsState.status })
          .from(caseLawDecisionCitationStatsState)
          .where(
            inArray(caseLawDecisionCitationStatsState.decisionId, decisionIds),
          );
        expect(states.map(({ status }) => status)).toEqual(
          ids.map(() => "exact"),
        );
      });
    });

    test("pending projections never claim an exact zero and explicit refresh completes them", async () => {
      await withFixture(async ({ client, ids }) => {
        const tx = drizzle({ client });
        const pending = toSafeId<"caseLawDecision">(member(ids, 1));
        const decisionIds = [pending];
        await client`DELETE FROM case_law_decision_citation_stats_state WHERE decision_id = ${pending}::uuid`;
        await insertEdge(client, { citing: member(ids, 0), cited: pending });
        const before = await compareProjection(client, ids);
        expect(before.actual).not.toEqual(before.expected);
        expect(await compareDecisionCitationStats({ tx, decisionIds })).toEqual(
          [{ status: "pending", decisionId: pending }],
        );
        expect(
          await reconcileDecisionCitationStats({
            tx,
            decisionIds,
            mode: "repair",
          }),
        ).toEqual([{ status: "pending", decisionId: pending }]);
        const stillPending = await compareProjection(client, ids);
        expect(stillPending.actual).toEqual(before.actual);
        await client`INSERT INTO case_law_decision_citation_stats_state (decision_id, status) VALUES (${pending}::uuid, 'pending')`;
        expect(await compareDecisionCitationStats({ tx, decisionIds })).toEqual(
          [{ status: "pending", decisionId: pending }],
        );
        await refreshDecisionCitationStats({ tx, decisionIds });
        const refreshed = await compareProjection(client, ids);
        expect(refreshed.actual).toEqual(refreshed.expected);
        expect(await compareDecisionCitationStats({ tx, decisionIds })).toEqual(
          [{ status: "consistent", decisionId: pending }],
        );
      });
    });

    for (const competingOperation of ["edge", "visibility"] as const) {
      for (const firstOperation of ["refresh", "competitor"] as const) {
        test(`${firstOperation} serializes refresh with ${competingOperation} and preserves the full recount`, async () => {
          if (!databaseUrl) {
            return;
          }
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const { sql: observer, db } = openClient();
            const first = openClient().sql;
            const second = openClient().sql;
            const source = caseLawSourceRow({
              adapterKey: `citation-overlap-${Bun.randomUUIDv7()}`,
            });
            const ids = [
              createSafeId<"caseLawDecision">(),
              createSafeId<"caseLawDecision">(),
            ];
            const refreshed = member(ids, 0);
            const far = member(ids, 1);
            const firstDone = Promise.withResolvers<undefined>();
            const releaseFirst = Promise.withResolvers<undefined>();
            const secondBlocked = Promise.withResolvers<boolean>();
            const tasks: Promise<unknown>[] = [];
            const refresh = async (client: SQL) => {
              await client`SELECT refresh_decision_citation_stats(${refreshed}::uuid)`;
            };
            const competitor = async (client: SQL) => {
              if (competingOperation === "edge") {
                await insertEdge(client, { citing: far, cited: refreshed });
                return;
              }
              await client`UPDATE case_law_decisions SET metadata = '{"_stellaPartialObservation":{"isListingOnly":true}}'::jsonb WHERE id = ${far}::uuid`;
            };
            try {
              await db.insert(caseLawSources).values(source);
              for (const id of ids) {
                await db.insert(caseLawDecisions).values({
                  id,
                  sourceId: source.id,
                  country: "CZE",
                  court: "Court",
                  language: "cs",
                  caseNumber: id,
                  decisionDate: "2020-01-01",
                  metadata: {},
                });
                await observer`SELECT refresh_decision_citation_stats(${id}::uuid)`;
              }
              await insertEdge(observer, { citing: far, cited: refreshed });
              const firstTask = first.begin(async (client) => {
                await client`SET LOCAL statement_timeout = '5s'`;
                await (firstOperation === "refresh"
                  ? refresh(client)
                  : competitor(client));
                firstDone.resolve(undefined);
                await releaseFirst.promise;
              });
              tasks.push(firstTask);
              await Promise.race([firstDone.promise, firstTask]);
              const secondTask = second.begin(async (client) => {
                await client`SET LOCAL statement_timeout = '5s'`;
                // Both contenders must take the refreshed anchor's advisory lock;
                // test the lock itself so a scheduler delay cannot prove overlap.
                const probe =
                  await client`SELECT NOT pg_try_advisory_xact_lock(19053, (hashtextextended('decision-citation-stats:' || ${refreshed}::text, 0) & 127)::integer) AS blocked`;
                secondBlocked.resolve(probe.at(0)?.blocked === true);
                await (firstOperation === "refresh"
                  ? competitor(client)
                  : refresh(client));
              });
              tasks.push(secondTask);
              expect(
                await Promise.race([
                  secondBlocked.promise,
                  secondTask.then(() => false),
                ]),
              ).toBe(true);
              releaseFirst.resolve(undefined);
              await Promise.all(tasks);
              const comparison = await compareProjection(observer, ids);
              expect(comparison.actual).toEqual(comparison.expected);
            } finally {
              releaseFirst.resolve(undefined);
              await Promise.allSettled(tasks);
              await observer`DELETE FROM case_law_decisions WHERE source_id = ${source.id}::uuid`;
              await observer`DELETE FROM case_law_sources WHERE id = ${source.id}::uuid`;
            }
          });
        }, 15_000);
      }
    }

    test("decision deletion and an edge tuple writer recover from a deadlock without projection drift", async () => {
      if (!databaseUrl) {
        return;
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: observer, db } = openClient();
        const source = caseLawSourceRow({
          adapterKey: `citation-delete-overlap-${Bun.randomUUIDv7()}`,
        });
        const ids = [
          createSafeId<"caseLawDecision">(),
          createSafeId<"caseLawDecision">(),
        ];
        const citing = member(ids, 0);
        const cited = member(ids, 1);
        const edge = Bun.randomUUIDv7();
        try {
          await db.insert(caseLawSources).values(source);
          for (const id of ids) {
            await db.insert(caseLawDecisions).values({
              id,
              sourceId: source.id,
              country: "CZE",
              court: "Court",
              language: "cs",
              caseNumber: id,
              decisionDate: "2020-01-01",
              metadata: {},
            });
            await observer`SELECT refresh_decision_citation_stats(${id}::uuid)`;
          }
          await insertEdge(observer, { citing, cited, id: edge });
          await withInterleaving({
            databaseUrl,
            a: {
              steps: [
                {
                  name: "lock-edge",
                  run: (tx) =>
                    tx.execute(
                      sql`SELECT id FROM case_law_citations WHERE id = ${edge}::uuid FOR UPDATE`,
                    ),
                },
                {
                  name: "delete-edge",
                  run: (tx) =>
                    tx.execute(
                      sql`DELETE FROM case_law_citations WHERE id = ${edge}::uuid`,
                    ),
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "lock-decision",
                  run: (tx) =>
                    tx.execute(
                      sql`SELECT id FROM case_law_decisions WHERE id = ${cited}::uuid FOR UPDATE`,
                    ),
                },
                {
                  name: "delete-decision",
                  run: (tx) =>
                    tx.execute(
                      sql`DELETE FROM case_law_decisions WHERE id = ${cited}::uuid`,
                    ),
                },
              ],
            },
            schedules: [
              [
                "a.lock-edge",
                "b.lock-decision",
                "a.delete-edge",
                "b.delete-decision",
                "a.commit",
                "b.commit",
              ],
            ],
            reset: async () => {},
            readState: async () => compareProjection(observer, ids),
            invariant: async ({ outcomes, state }) => {
              expect(
                Object.values(outcomes)
                  .map(({ status }) => status)
                  .toSorted(),
              ).toEqual(["committed", "deadlock"]);
              expect(state.actual).toEqual(state.expected);
              // PostgreSQL aborts a complete participant transaction. Retry its
              // operation once the survivor commits, as a transactional caller must.
              if (outcomes.a.status === "deadlock") {
                await observer`DELETE FROM case_law_citations WHERE id = ${edge}::uuid`;
              } else {
                await observer`DELETE FROM case_law_decisions WHERE id = ${cited}::uuid`;
              }
              const afterRetry = await compareProjection(observer, ids);
              expect(afterRetry.actual).toEqual(afterRetry.expected);
            },
            timeoutMs: 10_000,
          });
        } finally {
          await observer`DELETE FROM case_law_decisions WHERE source_id = ${source.id}::uuid`;
          await observer`DELETE FROM case_law_sources WHERE id = ${source.id}::uuid`;
        }
      });
    }, 20_000);

    test("visibility changes preserve exact projections across 2049 distinct citing decisions", async () => {
      if (!databaseUrl) {
        return;
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: client } = openClient();
        const source = caseLawSourceRow({
          adapterKey: `citation-fan-in-${Bun.randomUUIDv7()}`,
        });
        const target = createSafeId<"caseLawDecision">();
        const citingIds = Array.from({ length: 2049 }, () =>
          createSafeId<"caseLawDecision">(),
        );
        const allIds = [target, ...citingIds];
        try {
          await client.begin(async (tx) => {
            await tx`SET LOCAL statement_timeout = '30s'`;
            await drizzle({ client: tx }).insert(caseLawSources).values(source);
            await tx`INSERT INTO case_law_decisions (id, source_id, country, court, language, case_number, decision_date, metadata)
            SELECT id, ${source.id}::uuid, 'CZE', 'Court', 'cs', 'fan-in-' || id::text, '2020-01-01'::date, '{}'::jsonb
            FROM unnest(${tx.array(allIds, "TEXT")}::uuid[]) AS fixture(id)`;
            await tx`SELECT refresh_decision_citation_stats(id) FROM case_law_decisions WHERE id = ANY(${tx.array(allIds, "TEXT")}::uuid[])`;
            await tx`INSERT INTO case_law_citations (id, citing_decision_id, cited_decision_id, citation_text, kind)
            SELECT gen_random_uuid(), id, ${target}::uuid, 'fan-in-' || id::text, 'precedent'
            FROM case_law_decisions WHERE id = ANY(${tx.array(citingIds, "TEXT")}::uuid[])`;
            const initial = await compareProjection(tx, allIds);
            expect(initial.actual).toEqual(initial.expected);
          });
          for (const visibility of ["listing", "published"] as const) {
            await client.begin(async (tx) => {
              await tx`SET LOCAL lock_timeout = '2s'`;
              await tx`SET LOCAL statement_timeout = '30s'`;
              const before =
                await tx`SELECT count(*)::integer AS count FROM pg_locks
                WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND classid = 19053`;
              expect(before.at(0)?.count).toBe(0);
              const started = performance.now();
              await tx`UPDATE case_law_decisions SET metadata = ${JSON.stringify(visibility === "listing" ? { _stellaPartialObservation: { isListingOnly: true } } : {})}::text::jsonb WHERE id = ${target}::uuid`;
              const durationMs = performance.now() - started;
              const locks =
                await tx`SELECT count(*)::integer AS count FROM pg_locks
                WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND classid = 19053`;
              const advisoryLockCount =
                locks.at(0)?.count ??
                panic("Advisory lock census returned no row");
              expect(advisoryLockCount).toBeGreaterThan(0);
              expect(advisoryLockCount).toBeLessThanOrEqual(128);
              console.info(
                JSON.stringify({
                  event: "citation-stats-fan-in-visibility",
                  fanIn: citingIds.length,
                  visibility,
                  durationMs,
                  advisoryLockCount,
                }),
              );
              const comparison = await compareProjection(tx, allIds);
              expect(comparison.actual).toEqual(comparison.expected);
            });
          }
        } finally {
          await client`DELETE FROM case_law_decisions WHERE source_id = ${source.id}::uuid`;
          await client`DELETE FROM case_law_sources WHERE id = ${source.id}::uuid`;
        }
      });
    }, 60_000);

    const mutations = [
      {
        trigger: "case_law_citation_stats_edge_insert",
        table: "case_law_citations",
        operation: "insert",
      },
      {
        trigger: "case_law_citation_stats_edge_delete",
        table: "case_law_citations",
        operation: "delete",
      },
      {
        trigger: "case_law_citation_stats_edge_update",
        table: "case_law_citations",
        operation: "update",
      },
      {
        trigger: "case_law_citation_stats_decision_update",
        table: "case_law_decisions",
        operation: "decision-update",
      },
      {
        trigger: "case_law_citation_stats_decision_delete",
        table: "case_law_decisions",
        operation: "decision-delete",
      },
    ] as const;
    for (const mutation of mutations) {
      test(`full recount detects removal of ${mutation.trigger}`, async () => {
        await withFixture(async ({ client, ids }) => {
          const edge = await insertEdge(client, {
            citing: member(ids, 0),
            cited: member(ids, 1),
          });
          const before = await compareProjection(client, ids);
          expect(before.actual).toEqual(before.expected);
          await client.unsafe(
            `DROP TRIGGER ${mutation.trigger} ON ${mutation.table}`,
          );
          switch (mutation.operation) {
            case "insert":
              await insertEdge(client, {
                citing: member(ids, 2),
                cited: member(ids, 1),
              });
              break;
            case "delete":
              await client`DELETE FROM case_law_citations WHERE id = ${edge}::uuid`;
              break;
            case "update":
              await client`UPDATE case_law_citations SET polarity = 'negative' WHERE id = ${edge}::uuid`;
              break;
            case "decision-update":
              await client`UPDATE case_law_decisions SET decision_date = '2025-01-01' WHERE id = ${member(ids, 0)}::uuid`;
              break;
            case "decision-delete":
              await client`DELETE FROM case_law_decisions WHERE id = ${member(ids, 0)}::uuid`;
              break;
          }
          const after = await compareProjection(client, ids);
          expect(after.actual).not.toEqual(after.expected);
        });
      }, 15_000);
    }
  });
}
