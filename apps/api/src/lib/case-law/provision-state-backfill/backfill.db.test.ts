import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  PROVISION_STATE_BACKFILL_STEPS,
  runProvisionStateBackfill,
} from "./backfill";
import type { ProvisionBackfillSession } from "./step";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let connection: ProvisionBackfillSession;
const source = caseLawSourceRow();

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  connection = {
    setTransactionBudget: async () => undefined,
    execute: async (query, params = []) => {
      await client.query(query, [...params]);
    },
    query: async (query, params = []) =>
      (await client.query(query, [...params])).rows,
  };
  await db.insert(caseLawSources).values(source);
}, 120_000);
afterAll(async () => await client.close());

const insertDecision = async (country: string, language: string) => {
  const id = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id,
    sourceId: source.id,
    country,
    language,
    court: "Court",
    caseNumber: id,
    decisionDate: "2020-03-01",
    metadata: {},
  });
  return id;
};

const stepNamed = (name: string) =>
  PROVISION_STATE_BACKFILL_STEPS.find((step) => step.name === name) ??
  panic(`No provision backfill step named ${name}`);

/** Advances one step until it reports complete, as successive runs would. */
const completeStep = async (name: string): Promise<void> => {
  const step = stepNamed(name);
  for (let unit = 0; unit < 1000; unit += 1) {
    if ((await step.readCompletion(connection)).type === "complete") {
      return;
    }
    (await step.advance(connection)).unwrap();
  }
  panic(`Provision backfill step ${name} did not complete`);
};

const rows = async (text: string): Promise<Record<string, unknown>[]> =>
  (await client.query(text)).rows.filter(isRecord);

describe("provision state backfill", () => {
  /**
   * Runs as the scheduler would: the first stops at its deadline after one
   * committed page, and the next resumes from that page's cursor. The full
   * table scans run one per run, after every walk.
   */
  test("a run stops at its deadline and the next resumes from the committed cursor", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 3 }, async () => await insertDecision("CZE", "cs")),
    );
    // The test schema is pushed with every CHECK already valid; put one back
    // to NOT VALID, as the migration leaves it.
    await db.execute(sql`ALTER TABLE case_law_provision_citations
      DROP CONSTRAINT provision_citations_selection_values`);
    await db.execute(sql`ALTER TABLE case_law_provision_citations
      ADD CONSTRAINT provision_citations_selection_values
      CHECK (selection IS NULL OR selection IN ('text', 'date-window')) NOT VALID`);
    let clock = 0;
    const first = (
      await runProvisionStateBackfill({
        connection,
        deadline: 1,
        signal: new AbortController().signal,
        now: () => clock++,
      })
    ).unwrap();
    expect(first).toEqual({ type: "progress", step: "scope-bootstrap" });
    expect(
      await rows(`SELECT cursor_decision_id IS NOT NULL AS advanced,
        completed_at IS NULL AS pending
        FROM case_law_provision_repair_cursors WHERE name = 'scope-bootstrap'`),
    ).toEqual([{ advanced: true, pending: true }]);

    const outcomes: string[] = [];
    for (let run = 0; run < 20; run += 1) {
      const outcome = (
        await runProvisionStateBackfill({
          connection,
          deadline: Number.POSITIVE_INFINITY,
          signal: new AbortController().signal,
        })
      ).unwrap();
      outcomes.push(outcome.type === "progress" ? outcome.step : "complete");
      if (outcome.type === "complete") {
        break;
      }
    }
    // The first unbounded run finishes the walks and leaves the scan for a
    // run of its own; the next run validates; the third finds nothing owed.
    expect(outcomes).toEqual([
      "case-law-provision-citation-checks",
      "case-law-provision-citation-checks",
      "complete",
    ]);
    expect(
      await rows(`SELECT count(*)::int AS count FROM case_law_provision_extractions
        WHERE decision_id IN (${decisions.map((id) => `'${id}'`).join(", ")})`),
    ).toEqual([{ count: 3 }]);
    expect(
      await rows(`SELECT count(*)::int AS count FROM pg_constraint
        WHERE conname LIKE 'provision_citations_%' AND NOT convalidated`),
    ).toEqual([{ count: 0 }]);
  });

  test("a run stops after its unit budget with the cursor committed", async () => {
    await db.execute(sql`DELETE FROM case_law_provision_repair_cursors`);
    const outcome = (
      await runProvisionStateBackfill({
        connection,
        deadline: Number.POSITIVE_INFINITY,
        maxUnits: 1,
        signal: new AbortController().signal,
      })
    ).unwrap();
    expect(outcome).toEqual({ type: "progress", step: "scope-bootstrap" });
    expect(
      await rows(`SELECT cursor_decision_id IS NOT NULL AS advanced,
        completed_at IS NULL AS pending
        FROM case_law_provision_repair_cursors WHERE name = 'scope-bootstrap'`),
    ).toEqual([{ advanced: true, pending: true }]);
  });

  test("bootstraps missing rows and seeds state with durable cursors", async () => {
    // Walk again from the start; the cursors of the test above are complete.
    await db.execute(sql`DELETE FROM case_law_provision_repair_cursors`);
    const inScope = await insertDecision("CZE", "cs");
    const outOfScope = await insertDecision("ZZP", "zz");

    await db.execute(sql`ALTER TABLE case_law_provision_extraction_scopes
      DISABLE TRIGGER case_law_provision_extraction_scope_guard`);
    await db.execute(sql`DELETE FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'zz'`);
    await db.execute(sql`ALTER TABLE case_law_provision_extraction_scopes
      ENABLE TRIGGER case_law_provision_extraction_scope_guard`);

    await completeStep("scope-bootstrap");
    expect(
      await stepNamed("scope-bootstrap").readCompletion(connection),
    ).toEqual({ type: "complete" });
    expect(
      await rows(`SELECT status FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'zz'`),
    ).toEqual([{ status: "retired" }]);

    await completeStep("scope-seed");
    expect(await stepNamed("scope-seed").readCompletion(connection)).toEqual({
      type: "complete",
    });
    await completeStep("scope-transitions");
    expect(
      await stepNamed("scope-transitions").readCompletion(connection),
    ).toEqual({ type: "complete" });

    await completeStep("state-seed");
    expect(await stepNamed("state-seed").readCompletion(connection)).toEqual({
      type: "complete",
    });
    // Its scope was already active when it was written, so the enqueue
    // trigger created its state and the seeding walk left it alone.
    expect(
      await rows(`SELECT lane, enqueue_reason FROM case_law_provision_extractions
      WHERE decision_id = '${inScope}'`),
    ).toEqual([{ lane: "fresh", enqueue_reason: "input" }]);
    expect(
      await rows(`SELECT decision_id FROM case_law_provision_extractions
      WHERE decision_id = '${outOfScope}'`),
    ).toEqual([]);

    await completeStep("state-seed");
    expect(
      await rows(`SELECT count(*)::int AS count FROM case_law_provision_extractions
      WHERE decision_id = '${inScope}'`),
    ).toEqual([{ count: 1 }]);
  });

  test("obsolete retirement stops at its generation fence", async () => {
    const id = await insertDecision("ZZP", "z1");
    await db.execute(sql`UPDATE case_law_provision_extraction_scopes
      SET status = 'active', generation = generation + 1
      WHERE country = 'ZZP' AND language = 'z1'`);
    await db.execute(sql`INSERT INTO case_law_provision_scope_transitions
      (country, language, generation, action)
      SELECT country, language, generation, 'activate'
      FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'z1'`);
    await db.execute(sql`UPDATE case_law_provision_extraction_scopes
      SET status = 'retired', generation = generation + 1
      WHERE country = 'ZZP' AND language = 'z1'`);
    await db.execute(sql`INSERT INTO case_law_provision_scope_transitions
      (country, language, generation, action)
      SELECT country, language, generation, 'retire'
      FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'z1'`);
    await db.execute(sql`UPDATE case_law_provision_extraction_scopes
      SET status = 'active', generation = generation + 1
      WHERE country = 'ZZP' AND language = 'z1'`);
    await db.execute(sql`INSERT INTO case_law_provision_scope_transitions
      (country, language, generation, action)
      SELECT country, language, generation, 'activate'
      FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'z1'`);

    await completeStep("scope-transitions");
    expect(
      await stepNamed("scope-transitions").readCompletion(connection),
    ).toEqual({ type: "complete" });
    expect(
      await rows(`SELECT enqueue_reason FROM case_law_provision_extractions
      WHERE decision_id = '${id}'`),
    ).toEqual([{ enqueue_reason: "scope_activated" }]);
  });

  test("retirement schedules cleanup and reactivation restores admission", async () => {
    const id = await insertDecision("ZZP", "r1");
    await db.execute(sql`UPDATE case_law_provision_extraction_scopes
      SET status = 'active', generation = generation + 1
      WHERE country = 'ZZP' AND language = 'r1'`);
    await db.execute(sql`INSERT INTO case_law_provision_scope_transitions
      (country, language, generation, action)
      SELECT country, language, generation, 'activate'
      FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'r1'`);
    await completeStep("scope-transitions");
    await db.execute(sql`UPDATE case_law_provision_extractions SET due_at = NULL
      WHERE decision_id = ${id}`);

    await db.execute(sql`UPDATE case_law_provision_extraction_scopes
      SET status = 'retired', generation = generation + 1
      WHERE country = 'ZZP' AND language = 'r1'`);
    await db.execute(sql`INSERT INTO case_law_provision_scope_transitions
      (country, language, generation, action)
      SELECT country, language, generation, 'retire'
      FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'r1'`);
    await completeStep("scope-transitions");
    expect(
      await rows(`SELECT lane, enqueue_reason, due_at IS NOT NULL AS due
        FROM case_law_provision_extractions WHERE decision_id = '${id}'`),
    ).toEqual([{ lane: "repair", enqueue_reason: "scope_retired", due: true }]);

    await db.execute(sql`UPDATE case_law_provision_extraction_scopes
      SET status = 'active', generation = generation + 1
      WHERE country = 'ZZP' AND language = 'r1'`);
    await db.execute(sql`INSERT INTO case_law_provision_scope_transitions
      (country, language, generation, action)
      SELECT country, language, generation, 'activate'
      FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'r1'`);
    await completeStep("scope-transitions");
    expect(
      await rows(`SELECT enqueue_reason FROM case_law_provision_extractions
        WHERE decision_id = '${id}'`),
    ).toEqual([{ enqueue_reason: "scope_activated" }]);
  });

  test("a committed transition page resumes and later decision moves converge", async () => {
    const movedIn = await insertDecision("ZZP", "p3");
    const ids = Array.from({ length: 51 }, () =>
      createSafeId<"caseLawDecision">(),
    );
    await db.insert(caseLawDecisions).values(
      ids.map((id) => ({
        id,
        sourceId: source.id,
        country: "ZZP",
        language: "p1",
        court: "Court",
        caseNumber: id,
        decisionDate: "2020-03-01",
        metadata: {},
      })),
    );
    await db.execute(sql`UPDATE case_law_provision_extraction_scopes
      SET status = 'active', generation = generation + 1
      WHERE country = 'ZZP' AND language = 'p1'`);
    await db.execute(sql`INSERT INTO case_law_provision_scope_transitions
      (country, language, generation, action)
      SELECT country, language, generation, 'activate'
      FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'p1'`);
    const generation = String(
      (
        await rows(`SELECT generation FROM case_law_provision_extraction_scopes
      WHERE country = 'ZZP' AND language = 'p1'`)
      ).at(0)?.["generation"],
    );

    const page = async () =>
      (
        await client.query(
          `SELECT run_case_law_provision_scope_transition_page($1, $2, $3::bigint) AS more`,
          ["ZZP", "p1", generation],
        )
      ).rows.find(isRecord)?.["more"];
    expect(await page()).toBe(true);
    expect(
      await rows(`SELECT count(*)::int AS count
      FROM case_law_provision_extractions state
      JOIN case_law_decisions decision ON decision.id = state.decision_id
      WHERE decision.country = 'ZZP' AND decision.language = 'p1'`),
    ).toEqual([{ count: 50 }]);
    expect(
      await rows(`SELECT cursor_decision_id IS NOT NULL AS advanced,
      completed_at IS NULL AS pending FROM case_law_provision_scope_transitions
      WHERE country = 'ZZP' AND language = 'p1'`),
    ).toEqual([{ advanced: true, pending: true }]);

    const inserted = await insertDecision("ZZP", "p1");
    await db.execute(
      sql`UPDATE case_law_decisions SET language = 'p1' WHERE id = ${movedIn}`,
    );
    const movedOut = ids.toSorted().at(-1);
    if (movedOut === undefined) {
      throw new TypeError("Expected the last transition decision");
    }
    await db.execute(
      sql`UPDATE case_law_decisions SET language = 'p4' WHERE id = ${movedOut}`,
    );

    expect(await page()).toBe(true);
    expect(await page()).toBe(false);
    expect(
      await rows(`SELECT completed_at IS NOT NULL AS complete
      FROM case_law_provision_scope_transitions
      WHERE country = 'ZZP' AND language = 'p1'`),
    ).toEqual([{ complete: true }]);
    expect(
      await rows(`SELECT decision_id FROM case_law_provision_extractions
      WHERE decision_id = '${movedOut}'`),
    ).toEqual([]);
    expect(
      await rows(`SELECT count(*)::int AS count FROM case_law_provision_extractions
      WHERE decision_id IN ('${movedIn}', '${inserted}')`),
    ).toEqual([{ count: 2 }]);
  });
  test("an aborted run starts no unit after the abort", async () => {
    await db.execute(sql`DELETE FROM case_law_provision_repair_cursors`);
    await insertDecision("CZE", "cs");
    const controller = new AbortController();
    // The first deadline check aborts; the unit it admits still commits, and
    // nothing after it starts.
    const outcome = (
      await runProvisionStateBackfill({
        connection,
        deadline: Number.POSITIVE_INFINITY,
        signal: controller.signal,
        now: () => {
          controller.abort();
          return 0;
        },
      })
    ).unwrap();
    expect(outcome).toEqual({ type: "aborted", step: "scope-bootstrap" });
    expect(
      await rows(`SELECT cursor_decision_id IS NOT NULL AS advanced,
        completed_at IS NULL AS pending
        FROM case_law_provision_repair_cursors WHERE name = 'scope-bootstrap'`),
    ).toEqual([{ advanced: true, pending: true }]);
  });

  /**
   * A rolling deploy runs two builds at once. Once the newer one has applied
   * its admission, the older one changes nothing, even though its own
   * admission lacks the scope the newer one added.
   */
  test("a build older than the applied admission leaves the scopes alone", async () => {
    const current = { country: "CZE", language: "cs" };
    const added = { country: "ZZA", language: "zz" };
    const run = async (revision: number, scopes: readonly (typeof current)[]) =>
      (
        await runProvisionStateBackfill({
          connection,
          deadline: Number.POSITIVE_INFINITY,
          signal: new AbortController().signal,
          admission: { revision, scopes },
        })
      ).unwrap();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if ((await run(2, [current, added])).type === "complete") {
        break;
      }
    }
    const scopeRows = async () =>
      await rows(`SELECT country, language, status
        FROM case_law_provision_extraction_scopes
        WHERE (country, language) IN (('CZE', 'cs'), ('ZZA', 'zz'))
        ORDER BY country`);
    const transitionCount = async () =>
      await rows(`SELECT count(*)::int AS count
        FROM case_law_provision_scope_transitions`);
    expect(await scopeRows()).toEqual([
      { country: "CZE", language: "cs", status: "active" },
      { country: "ZZA", language: "zz", status: "active" },
    ]);
    const transitionsBefore = await transitionCount();

    expect(await run(1, [current])).toEqual({
      type: "superseded",
      appliedRevision: 2,
    });
    expect(await scopeRows()).toEqual([
      { country: "CZE", language: "cs", status: "active" },
      { country: "ZZA", language: "zz", status: "active" },
    ]);
    expect(await transitionCount()).toEqual(transitionsBefore);
    expect(
      await rows(`SELECT revision FROM case_law_provision_admission`),
    ).toEqual([{ revision: 2 }]);
  });

  test("a run stops once a newer admission is applied between its units", async () => {
    await db.execute(sql`DELETE FROM case_law_provision_repair_cursors`);
    await insertDecision("CZE", "cs");
    // Stands in for a newer release committing its admission right after
    // this run's first unit commits.
    let commits = 0;
    const racing: ProvisionBackfillSession = {
      setTransactionBudget: async (budget) =>
        await connection.setTransactionBudget(budget),
      execute: async (query, params = []) => {
        await connection.execute(query, params);
        if (query === "COMMIT") {
          commits += 1;
          if (commits === 1) {
            await connection.execute(
              "UPDATE case_law_provision_admission SET revision = 7 WHERE key = 'global'",
            );
          }
        }
      },
      query: async (query, params = []) =>
        await connection.query(query, params),
    };
    const outcome = (
      await runProvisionStateBackfill({
        connection: racing,
        deadline: Number.POSITIVE_INFINITY,
        signal: new AbortController().signal,
        admission: {
          revision: 2,
          scopes: [{ country: "CZE", language: "cs" }],
        },
      })
    ).unwrap();
    expect(outcome).toEqual({ type: "superseded", appliedRevision: 7 });
    expect(commits).toBe(1);
  });
});

test.each(["scope-bootstrap", "state-seed"] as const)(
  "a delayed %s unit preserves a cursor already completed by another worker",
  async (name) => {
    await completeStep(name);
    const before = await rows(
      `SELECT * FROM case_law_provision_repair_cursors WHERE name = '${name}'`,
    );
    expect((await stepNamed(name).readCompletion(connection)).type).toBe(
      "complete",
    );
    const result = await stepNamed(name).advance(connection);
    expect(result.isOk()).toBe(true);
    expect(
      await rows(
        `SELECT * FROM case_law_provision_repair_cursors WHERE name = '${name}'`,
      ),
    ).toEqual(before);
  },
);
