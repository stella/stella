import type { SQL } from "bun";
/**
 * The provision-citation state behaviour PGlite cannot show, on real
 * Postgres: a scope row another session is inserting, lock waits, and
 * settings on a pooled connection. PGlite behaviour lives in
 * `case-law-provision-extraction-state.db.test.ts`.
 *
 * Scope rows are never deleted by design, so each test uses a language
 * code of its own and leaves its scope rows behind.
 */
import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import { ADAPTER_KEYS, PARSER_VERSIONS } from "@/api/handlers/case-law/consts";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { runProvisionStateBackfill } from "@/api/lib/case-law/provision-state-backfill/backfill";
import type { RawIngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { withReservedSession } from "@/api/lib/scheduler/tasks/case-law-provision-state-backfill";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const COUNTRY = "ZZP";

const uniqueLanguage = (): string =>
  `x${Bun.randomUUIDv7().replaceAll("-", "").slice(-7)}`;

/** Wait until `pid` is blocked on a lock, so timing cannot make a test vacuous. */
const waitUntilBlocked = async (observer: SQL, pid: number) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const [row] =
      await observer`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`;
    if (row?.blocked === true) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`backend ${String(pid)} never blocked`);
};

const backendPid = async (client: SQL): Promise<number> => {
  const [row] = await client`SELECT pg_backend_pid() AS pid`;
  const pid: unknown = row?.pid;
  if (typeof pid !== "number") {
    throw new TypeError("Expected a PostgreSQL backend pid");
  }
  return pid;
};

type Fixture = {
  sourceId: SafeId<"caseLawSource">;
};

const insertDecision = async (
  client: SQL,
  fixture: Fixture,
  language: string,
): Promise<SafeId<"caseLawDecision">> => {
  const id = createSafeId<"caseLawDecision">();
  await client`
    INSERT INTO case_law_decisions
      (id, source_id, country, language, court, case_number, decision_date, metadata)
    VALUES (${id}::uuid, ${fixture.sourceId}::uuid, ${COUNTRY}, ${language},
      'Court', ${id}, '2020-03-01', '{}'::jsonb)`;
  return id;
};

const withFixture = async (
  fn: (tools: {
    openClient: (options?: { max?: number }) => { sql: SQL; db: GatedTestDb };
    observer: SQL;
    fixture: Fixture;
  }) => Promise<void>,
) => {
  if (!databaseUrl || !runPostgresTests) {
    return;
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { sql: observer } = openClient();
    const source = { id: createSafeId<"caseLawSource">() };
    const fixture: Fixture = { sourceId: source.id };
    await observer`INSERT INTO case_law_sources (id, adapter_key, name)
      VALUES (${source.id}::uuid, ${`provision-state-${Bun.randomUUIDv7()}`}, 'Test source')`;
    try {
      await fn({ openClient, observer, fixture });
    } finally {
      await observer`DELETE FROM case_law_decisions WHERE source_id = ${source.id}::uuid`;
      await observer`DELETE FROM case_law_sources WHERE id = ${source.id}::uuid`;
    }
  });
};

const stateOf = async (observer: SQL, id: string) =>
  (
    await observer`
      SELECT lane, enqueue_reason AS "enqueueReason"
      FROM case_law_provision_extractions WHERE decision_id = ${id}::uuid
    `
  ).at(0);

if (!databaseUrl || !runPostgresTests) {
  describe.skip("provision extraction state (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("provision extraction state (postgres)", () => {
    /**
     * The trigger's scope insert waits for a concurrent insert of the same
     * key, and routes on the row that won, read in a later statement: here
     * an activation committing while the decision write waits.
     */
    for (const outcome of ["commit", "rollback"] as const) {
      test(`routes on the scope row a concurrent insert won (${outcome})`, async () => {
        await withFixture(async ({ openClient, observer, fixture }) => {
          const language = uniqueLanguage();
          const activation = openClient().sql;
          const writer = openClient();
          const activated = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const transition = activation.begin(async (tx) => {
            await tx`INSERT INTO case_law_provision_extraction_scopes (country, language, status, generation)
              VALUES (${COUNTRY}, ${language}, 'active', 1)`;
            activated.resolve(undefined);
            await release.promise;
            if (outcome === "rollback") {
              throw new Error("roll the activation back");
            }
          });
          try {
            await activated.promise;
            const pid = await backendPid(writer.sql);
            const write = insertDecision(writer.sql, fixture, language);
            await waitUntilBlocked(observer, pid);
            release.resolve(undefined);
            // swallow-ok: deliberate activation rollback is distinguished by the scope and decision-state assertions below
            await transition.catch(() => undefined);
            const id = await write;
            const [scope] = await observer`
              SELECT status FROM case_law_provision_extraction_scopes
              WHERE country = ${COUNTRY} AND language = ${language}`;
            if (outcome === "commit") {
              expect(scope?.status).toBe("active");
              expect(await stateOf(observer, id)).toEqual({
                lane: "fresh",
                enqueueReason: "input",
              });
            } else {
              expect(scope?.status).toBe("retired");
              expect(await stateOf(observer, id)).toBeUndefined();
            }
          } finally {
            release.resolve(undefined);
            // swallow-ok: final drain of the released activation transaction preserves any earlier assertion failure
            await transition.catch(() => undefined);
          }
        });
      }, 15_000);
    }

    test("a lane set in one transaction does not leak to the next on the pooled connection", async () => {
      await withFixture(async ({ openClient, observer, fixture }) => {
        const language = uniqueLanguage();
        await observer`INSERT INTO case_law_provision_extraction_scopes (country, language, status, generation)
          VALUES (${COUNTRY}, ${language}, 'active', 1)`;
        const pooled = openClient();
        const bulkId = createSafeId<"caseLawDecision">();
        await pooled.sql.begin(async (tx) => {
          await tx`SET LOCAL stella.provision_extraction_lane = 'backfill'`;
          await tx`INSERT INTO case_law_decisions (id, source_id, country, language, court, case_number, metadata)
            VALUES (${bulkId}::uuid, ${fixture.sourceId}::uuid, ${COUNTRY}, ${language}, 'Court', ${bulkId}, '{}'::jsonb)`;
        });
        const ordinaryId = await insertDecision(pooled.sql, fixture, language);
        expect((await stateOf(observer, bulkId))?.lane).toBe("backfill");
        expect((await stateOf(observer, ordinaryId))?.lane).toBe("fresh");
      });
    }, 15_000);

    test("the input digest is the same under any session DateStyle and TimeZone", async () => {
      await withFixture(async ({ openClient, fixture }) => {
        const id = await insertDecision(
          openClient().sql,
          fixture,
          uniqueLanguage(),
        );
        const digests = new Set<string>();
        for (const [dateStyle, timeZone] of [
          ["ISO, YMD", "UTC"],
          ["SQL, DMY", "Pacific/Kiritimati"],
          ["German", "America/Adak"],
          ["Postgres, MDY", "Asia/Kathmandu"],
        ] as const) {
          const session = openClient().sql;
          await session`SELECT set_config('DateStyle', ${dateStyle}, false), set_config('TimeZone', ${timeZone}, false)`;
          const [row] = await session`
            SELECT encode(case_law_provision_extraction_input_digest(decision), 'hex') AS digest
            FROM case_law_decisions decision WHERE decision.id = ${id}::uuid`;
          digests.add(String(row?.digest));
        }
        expect(digests.size).toBe(1);
      });
    }, 15_000);

    /**
     * The ingestion write path enqueues through the trigger like any other
     * writer: a new decision is owed, a refresh that changes an input is
     * owed again, and a refresh that changes nothing the digest reads is not.
     */
    test("ingestion enqueues new and changed decisions, not unchanged refreshes", async () => {
      await withFixture(async ({ openClient, observer, fixture }) => {
        const language = uniqueLanguage();
        await observer`INSERT INTO case_law_provision_extraction_scopes (country, language, status, generation)
          VALUES (${COUNTRY}, ${language}, 'active', 1)`;
        const { db } = openClient();
        const scopedDb: ScopedDb = async (callback) =>
          await db.transaction(async (tx) => await callback(tx));
        const input = plainTextIngestionResult({
          caseNumber: `provision-state-${Bun.randomUUIDv7()}`,
          court: "Court",
          country: COUNTRY,
          language,
          decisionDate: "2009-08-26",
          decisionType: "rozsudek",
          fulltext: "Text.",
          metadata: { source: "provision-state" },
          textFields: absentDecisionTextFields(
            TEXT_ABSENCE_REASON.NOT_PUBLISHED,
          ),
          rawHash: "provision-state-1",
          parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NS],
          documentAst: {
            version: 1,
            source: {
              system: ADAPTER_KEYS.CZ_NS,
              documentId: "provision-state",
              webUrl: "https://example.test/web",
              printUrl: "https://example.test/print",
            },
            metadata: {
              caseNumber: null,
              ecli: null,
              court: null,
              decisionDate: null,
              decisionType: null,
              keywords: [],
              statutes: [],
            },
            blocks: [
              {
                id: "b1",
                anchorId: "p1",
                type: "paragraph",
                inlines: [{ type: "text", text: "Text." }],
                plainText: "Text.",
              },
            ],
          } satisfies DocumentAst,
        });
        const ingest = async (
          observationOrder: bigint,
          overrides: Partial<RawIngestionResult>,
        ) => {
          await processDecision({
            input: plainTextIngestionResult({ ...input, ...overrides }),
            observationOrder,
            sourceId: fixture.sourceId,
            scopedDb,
            observedAt: new Date(),
          });
        };
        const owed = async () => {
          const [row] = await observer`
            SELECT decision.id, state.due_at IS NOT NULL AS due,
              state.desired_input_digest = case_law_provision_extraction_input_digest(decision) AS current
            FROM case_law_decisions decision
            JOIN case_law_provision_extractions state ON state.decision_id = decision.id
            WHERE decision.source_id = ${fixture.sourceId}::uuid`;
          return row;
        };

        await ingest(1n, {});
        const first = await owed();
        expect(first).toMatchObject({ due: true, current: true });

        await observer`UPDATE case_law_provision_extractions SET due_at = NULL
          WHERE decision_id = ${first?.id}::uuid`;
        await ingest(2n, {
          rawHash: "provision-state-2",
          metadata: { source: "provision-state-refresh" },
        });
        expect(await owed()).toMatchObject({ due: false, current: true });

        await ingest(3n, {
          rawHash: "provision-state-3",
          decisionDate: "2009-08-27",
        });
        expect(await owed()).toMatchObject({ due: true, current: true });
      });
    }, 30_000);

    /**
     * Under the ingestion role, as deployed: its decision write creates state
     * through the owner-run trigger, while its own insert into the state
     * table and its own read of a scope row are refused.
     */
    test("ingestion creates state only through the owner-run functions", async () => {
      await withFixture(async ({ openClient, observer, fixture }) => {
        const language = uniqueLanguage();
        await observer`INSERT INTO case_law_provision_extraction_scopes (country, language, status, generation)
          VALUES (${COUNTRY}, ${language}, 'active', 1)`;
        const ingestion = openClient().sql;
        const id = createSafeId<"caseLawDecision">();
        await ingestion.begin(async (tx) => {
          await tx`SET LOCAL ROLE stella_ingestion`;
          await tx`INSERT INTO case_law_decisions (id, source_id, country, language, court, case_number, metadata)
            VALUES (${id}::uuid, ${fixture.sourceId}::uuid, ${COUNTRY}, ${language}, 'Court', ${id}, '{}'::jsonb)`;
        });
        expect(await stateOf(observer, id)).toEqual({
          lane: "fresh",
          enqueueReason: "input",
        });
        const refused = async (query: (tx: SQL) => Promise<unknown>) =>
          await ingestion
            .begin(async (tx) => {
              await tx`SET LOCAL ROLE stella_ingestion`;
              await query(tx);
              return "allowed";
            })
            .catch((error: unknown) =>
              error instanceof Error ? error.message : String(error),
            );
        expect(
          await refused(
            async (tx) =>
              await tx`INSERT INTO case_law_provision_extractions
              (decision_id, jurisdiction, desired_input_digest, lane)
              VALUES (${id}::uuid, ${COUNTRY}, sha256('x'::bytea), 'fresh')`,
          ),
        ).toMatch(/permission denied/u);
        expect(
          await refused(
            async (tx) =>
              await tx`SELECT status FROM case_law_provision_extraction_scopes`,
          ),
        ).toMatch(/permission denied/u);
      });
    }, 15_000);

    /**
     * `ensure_…_state` locks the decision rows before it touches state: while
     * another session holds a decision, the call waits and holds no state
     * row, so a publisher following the same order is never inverted.
     */
    test("ensure takes the decision lock before any state row", async () => {
      await withFixture(async ({ openClient, observer, fixture }) => {
        const language = uniqueLanguage();
        await observer`INSERT INTO case_law_provision_extraction_scopes (country, language, status, generation)
          VALUES (${COUNTRY}, ${language}, 'active', 1)`;
        const id = await insertDecision(openClient().sql, fixture, language);
        await observer`UPDATE case_law_provision_extractions
          SET desired_input_digest = sha256('stale'::bytea), due_at = NULL
          WHERE decision_id = ${id}::uuid`;
        const holder = openClient().sql;
        const caller = openClient().sql;
        const held = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const holding = holder.begin(async (tx) => {
          await tx`SELECT 1 FROM case_law_decisions WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
          held.resolve(undefined);
          await release.promise;
        });
        try {
          await held.promise;
          const pid = await backendPid(caller);
          // Started now: a Bun SQL query runs only once awaited.
          const ensuring = (async () =>
            await caller`SELECT ensure_case_law_provision_extraction_state(ARRAY[${id}::uuid], 'reconcile') AS written`)();
          await waitUntilBlocked(observer, pid);
          const [free] = await observer.begin(
            async (tx) =>
              await tx`
            SELECT decision_id FROM case_law_provision_extractions
            WHERE decision_id = ${id}::uuid FOR UPDATE NOWAIT`,
          );
          expect(free?.decision_id).toBe(id);
          release.resolve(undefined);
          await holding;
          const [result] = await ensuring;
          expect(result?.written).toBe(1);
          expect(await stateOf(observer, id)).toEqual({
            lane: "repair",
            enqueueReason: "reconcile",
          });
        } finally {
          release.resolve(undefined);
          // swallow-ok: finally drains the row-lock holder after the repair result has been asserted
          await holding.catch(() => undefined);
        }
      });
    }, 15_000);

    test("a transition page waits for decisions before locking its scope", async () => {
      await withFixture(async ({ openClient, observer, fixture }) => {
        const language = uniqueLanguage();
        const id = await insertDecision(openClient().sql, fixture, language);
        const [activated] = await observer`
          UPDATE case_law_provision_extraction_scopes
          SET status = 'active', generation = generation + 1
          WHERE country = ${COUNTRY} AND language = ${language}
          RETURNING generation`;
        const activeGeneration = String(activated?.generation);
        await observer`INSERT INTO case_law_provision_scope_transitions
          (country, language, generation, action)
          VALUES (${COUNTRY}, ${language}, ${activeGeneration}::bigint, 'activate')`;

        const holder = openClient().sql;
        const runner = openClient().sql;
        const held = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const holding = holder.begin(async (tx) => {
          await tx`SELECT 1 FROM case_law_decisions
            WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
          held.resolve(undefined);
          await release.promise;
        });
        try {
          await held.promise;
          const pid = await backendPid(runner);
          const running = (async () =>
            await runner`SELECT run_case_law_provision_scope_transition_page(
              ${COUNTRY}, ${language}, ${activeGeneration}::bigint) AS more`)();
          await waitUntilBlocked(observer, pid);

          const retiredGeneration = await observer.begin(async (tx) => {
            const [retired] = await tx`
              UPDATE case_law_provision_extraction_scopes
              SET status = 'retired', generation = generation + 1
              WHERE country = ${COUNTRY} AND language = ${language}
              RETURNING generation`;
            await tx`INSERT INTO case_law_provision_scope_transitions
              (country, language, generation, action)
              VALUES (${COUNTRY}, ${language}, ${String(retired?.generation)}::bigint, 'retire')`;
            return Number(retired?.generation);
          });
          expect(retiredGeneration).toBe(Number(activeGeneration) + 1);
          release.resolve(undefined);
          await holding;
          expect((await running).at(0)?.more).toBe(false);
          const [obsolete] = await observer`
            SELECT completed_at IS NOT NULL AS complete
            FROM case_law_provision_scope_transitions
            WHERE country = ${COUNTRY} AND language = ${language}
              AND generation = ${activeGeneration}::bigint`;
          expect(obsolete?.complete).toBe(true);
          expect(await stateOf(observer, id)).toBeUndefined();
        } finally {
          release.resolve(undefined);
          // swallow-ok: finally drains the released holder after the obsolete transition state has been asserted
          await holding.catch(() => undefined);
        }
      });
    }, 15_000);

    /**
     * The backfill on the driver the scheduler uses: a reserved Bun SQL
     * session, whose `unsafe` binds a JavaScript array as text. Every list
     * the steps bind is a joined string, so the walks, the transition pages
     * and the CHECK scans all run here to completion.
     */
    test("the backfill completes on a reserved Bun SQL session", async () => {
      await withFixture(async ({ openClient, fixture }) => {
        // Two connections: one reserved for the backfill, one for the checks.
        const { sql: client } = openClient({ max: 2 });
        await insertDecision(client, fixture, uniqueLanguage());
        const reserved = await client.reserve();
        try {
          const session = {
            setTransactionBudget: async () => undefined,
            execute: async (
              query: string,
              params: readonly (
                | string
                | number
                | bigint
                | boolean
                | null
              )[] = [],
            ) => {
              await reserved.unsafe(query, [...params]);
            },
            query: async (
              query: string,
              params: readonly (
                | string
                | number
                | bigint
                | boolean
                | null
              )[] = [],
            ): Promise<readonly unknown[]> =>
              await reserved.unsafe(query, [...params]),
          };
          const outcomes: string[] = [];
          for (let run = 0; run < 20; run += 1) {
            const outcome = (
              await runProvisionStateBackfill({
                connection: session,
                deadline: Number.POSITIVE_INFINITY,
                signal: new AbortController().signal,
              })
            ).unwrap();
            outcomes.push(outcome.type);
            if (outcome.type === "complete") {
              break;
            }
          }
          expect(outcomes.at(-1)).toBe("complete");
          const [pending] = await client`
            SELECT count(*)::int AS count FROM pg_constraint
            WHERE conname LIKE 'provision_citations_%' AND NOT convalidated`;
          expect(pending?.count).toBe(0);
        } finally {
          reserved.release();
        }
      });
    }, 120_000);

    /**
     * Bun's `cancel()` does not stop a statement that has started, so the
     * abort cancels the backend from another connection, and the aborted
     * connection is closed, never pooled, once that cancel has settled.
     */
    test("an abort stops the statement in flight and discards its connection", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const pool = openClient({ max: 2 }).sql;
        const observer = openClient().sql;
        const controller = new AbortController();
        let reservedPid: unknown;
        const started = Date.now();
        const outcome = await withReservedSession({
          reserve: async () => await pool.reserve(),
          cancelBackend: async (pid) =>
            await observer`SELECT pg_cancel_backend(${pid})`,
          signal: controller.signal,
          work: async (session) => {
            const [row] = await session.query("SELECT pg_backend_pid() AS pid");
            reservedPid =
              row !== null && typeof row === "object" && "pid" in row
                ? row.pid
                : undefined;
            setTimeout(() => {
              controller.abort();
            }, 200);
            return await session.query("SELECT pg_sleep(30)").then(
              () => "finished",
              () => "cancelled",
            );
          },
        });
        expect(outcome).toBe("cancelled");
        expect(Date.now() - started).toBeLessThan(10_000);
        const [alive] = await observer`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE pid = ${Number(reservedPid)}`;
        expect(alive?.count).toBe(0);
      });
    }, 30_000);
  });
}
