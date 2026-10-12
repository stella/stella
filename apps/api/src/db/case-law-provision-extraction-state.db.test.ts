import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
/**
 * The per-decision provision-citation state, on the embedded test database:
 * the input digest, the decision enqueue trigger, `ensure_…_state`, and the
 * guards on scopes and revisions. PGlite is one session, so everything that
 * needs two connections (a scope row inserted concurrently, lock waits) is
 * in `case-law-provision-extraction-state.postgres.test.ts`.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
// Raw SQL rather than the ORM throughout: the decision table's insert types
// are among the most expensive in the API's type check, and nothing here
// needs them.
const SOURCE_ID = createSafeId<"caseLawSource">();

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.execute(sql`
    INSERT INTO case_law_sources (id, adapter_key, name)
    VALUES (${SOURCE_ID}, 'provision-state', 'Test source')
  `);
}, propertyTestTimeout(120_000));
afterAll(async () => await client.close());

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

const rows = async (query: SQL): Promise<Record<string, unknown>[]> =>
  (await db.execute(query)).rows;

const run = async (query: SQL): Promise<void> => {
  await db.execute(query);
};

/**
 * The database's own message for a refused operation. The driver's error
 * wraps it as `cause`, so the whole chain is read.
 */
const refusal = async (operation: Promise<unknown>): Promise<string> => {
  const failure: unknown = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  const messages: string[] = [];
  let current: unknown = failure;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages).not.toEqual([]);
  return messages.join("\n");
};

const one = async (query: SQL): Promise<Record<string, unknown>> => {
  const [row] = await rows(query);
  expect(row).toBeDefined();
  return row ?? {};
};

type DecisionId = SafeId<"caseLawDecision">;

type DecisionInputs = {
  contentHash: string | null;
  decisionDate: string | null;
  country: string;
  language: string;
  redactedAt: string | null;
};

const BASE_INPUTS: DecisionInputs = {
  contentHash: "a".repeat(64),
  decisionDate: "2020-03-01",
  country: "CZE",
  language: "cs",
  redactedAt: null,
};

const setScope = async (
  country: string,
  language: string,
  status: "active" | "retired",
) => {
  await db.execute(sql`
    INSERT INTO case_law_provision_extraction_scopes AS scope (country, language, status, generation)
    VALUES (${country}, ${language}, ${status}, 1)
    ON CONFLICT ON CONSTRAINT case_law_provision_extraction_scopes_pkey
    DO UPDATE SET status = EXCLUDED.status, generation = scope.generation + 1
  `);
};

const decisionInsert = (
  id: DecisionId,
  inputs: Partial<DecisionInputs> = {},
): SQL => {
  const { contentHash, country, decisionDate, language, redactedAt } = {
    ...BASE_INPUTS,
    ...inputs,
  };
  return sql`
    INSERT INTO case_law_decisions (
      id, source_id, court, case_number, metadata,
      content_hash, decision_date, country, language, redacted_at
    ) VALUES (
      ${id}, ${SOURCE_ID}, 'Court', ${id}, '{}'::jsonb,
      ${contentHash}, ${decisionDate}, ${country}, ${language}, ${redactedAt}
    )
  `;
};

const insertDecision = async (
  inputs: Partial<DecisionInputs> = {},
): Promise<DecisionId> => {
  const id = createSafeId<"caseLawDecision">();
  await run(decisionInsert(id, inputs));
  return id;
};

/**
 * Runs `statements` in one transaction and returns the last one's rows: the
 * only transaction this suite opens, so `SET LOCAL` settings and roles last
 * exactly as long as the statements that need them.
 */
const inTransaction = async (
  statements: readonly SQL[],
): Promise<Record<string, unknown>[]> =>
  await db.transaction(async (tx) => {
    let last: Record<string, unknown>[] = [];
    for (const statement of statements) {
      last = (await tx.execute(statement)).rows;
    }
    return last;
  });

type StateRow = {
  lane: string;
  dueAt: unknown;
  enqueueReason: string | null;
  jurisdiction: string;
  workStatus: string;
  leaseToken: unknown;
  failureAttempts: number;
  transientAttempts: number;
  retryNotBefore: unknown;
  digestIsCurrent: boolean;
};

const readState = async (id: DecisionId): Promise<StateRow | null> => {
  const [row] = await rows(sql`
    SELECT state.lane, state.due_at AS "dueAt", state.enqueue_reason AS "enqueueReason",
      state.jurisdiction, state.work_status AS "workStatus", state.lease_token AS "leaseToken",
      state.failure_attempts AS "failureAttempts", state.transient_attempts AS "transientAttempts",
      state.retry_not_before AS "retryNotBefore",
      state.desired_input_digest = case_law_provision_extraction_input_digest(decision) AS "digestIsCurrent"
    FROM case_law_provision_extractions state
    JOIN case_law_decisions decision ON decision.id = state.decision_id
    WHERE state.decision_id = ${id}
  `);
  if (row === undefined) {
    return null;
  }
  return {
    lane: String(row["lane"]),
    dueAt: row["dueAt"],
    enqueueReason:
      typeof row["enqueueReason"] === "string" ? row["enqueueReason"] : null,
    jurisdiction: String(row["jurisdiction"]),
    workStatus: String(row["workStatus"]),
    leaseToken: row["leaseToken"],
    failureAttempts: Number(row["failureAttempts"]),
    transientAttempts: Number(row["transientAttempts"]),
    retryNotBefore: row["retryNotBefore"],
    digestIsCurrent: row["digestIsCurrent"] === true,
  };
};

/** What the publisher leaves behind: nothing owed. */
const settle = async (id: DecisionId) => {
  await db.execute(sql`
    UPDATE case_law_provision_extractions SET due_at = NULL WHERE decision_id = ${id}
  `);
};

const digestOf = async (id: DecisionId): Promise<string> =>
  String(
    (
      await one(sql`
        SELECT encode(case_law_provision_extraction_input_digest(decision), 'hex') AS digest
        FROM case_law_decisions decision WHERE decision.id = ${id}
      `)
    )["digest"],
  );

const ensure = async (ids: DecisionId[], action: string): Promise<number> =>
  Number(
    (
      await one(sql`
        SELECT ensure_case_law_provision_extraction_state(
          ARRAY[${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[],
          ${action}
        ) AS written
      `)
    )["written"],
  );

beforeEach(async () => {
  await setScope("CZE", "cs", "active");
  await setScope("SVK", "sk", "active");
});

/**
 * An input variant, applied to a stored decision's row value rather than
 * written: the table's own CHECKs refuse some inputs the digest must still
 * encode (an infinite date; a redaction beside a content hash).
 */
type InputVariant = {
  content_hash: string | null;
  decision_date: string | null;
  country: string;
  language: string;
  redacted_at: string | null;
};

const variantDigests = async (
  variants: readonly InputVariant[],
): Promise<string[]> => {
  const base = await insertDecision();
  const digests = await rows(sql`
    SELECT encode(case_law_provision_extraction_input_digest(
      jsonb_populate_record(decision, variant.value)
    ), 'hex') AS digest
    FROM case_law_decisions decision
    CROSS JOIN LATERAL jsonb_array_elements(${JSON.stringify(variants)}::text::jsonb)
      WITH ORDINALITY AS variant(value, position)
    WHERE decision.id = ${base}
    ORDER BY variant.position
  `);
  return digests.map((row) => String(row["digest"]));
};

const withSessionSettings = async <T>(
  { dateStyle, timeZone }: { dateStyle: string; timeZone: string },
  read: () => Promise<T>,
): Promise<T> => {
  await run(sql`SELECT set_config('DateStyle', ${dateStyle}, false)`);
  await run(sql`SELECT set_config('TimeZone', ${timeZone}, false)`);
  try {
    return await read();
  } finally {
    await run(sql.raw("RESET DateStyle"));
    await run(sql.raw("RESET TimeZone"));
  }
};

const DAY_MS = 86_400_000;
const EPOCH_2000 = Date.UTC(2000, 0, 1);

const isoDay = (dayOffset: number): string =>
  new Date(EPOCH_2000 + dayOffset * DAY_MS).toISOString().slice(0, 10);

/** Small domains, so two draws collide often enough to test equality too. */
const inputVariant: fc.Arbitrary<InputVariant> = fc.record({
  content_hash: fc.constantFrom(null, "", "a".repeat(64), "b".repeat(64)),
  decision_date: fc.oneof(
    fc.constantFrom(null, "infinity", "-infinity"),
    // Years 1 to 9999, the range an ISO day string spells.
    fc.integer({ min: -730_119, max: 2_921_938 }).map(isoDay),
    fc.integer({ min: -3, max: 3 }).map(isoDay),
  ),
  country: fc.constantFrom("CZE", "SVK"),
  language: fc.constantFrom("cs", "sk"),
  redacted_at: fc.constantFrom(
    null,
    "2026-01-01T23:30:00+00:00",
    "2026-01-02T00:30:00+14:00",
  ),
});

/** What the digest must distinguish: redaction is only "is it redacted". */
const canonicalInputs = (variant: InputVariant): string =>
  JSON.stringify([
    variant.content_hash,
    variant.decision_date,
    variant.country,
    variant.language,
    variant.redacted_at === null,
  ]);

const SESSION_SETTINGS = [
  { dateStyle: "SQL, DMY", timeZone: "Pacific/Kiritimati" },
  { dateStyle: "German", timeZone: "America/Adak" },
  { dateStyle: "Postgres, MDY", timeZone: "UTC" },
  { dateStyle: "ISO, YMD", timeZone: "Asia/Kathmandu" },
] as const;

describe("input digest", () => {
  test("scalar reader overload matches the row overload for every input shape", async () => {
    const variants: InputVariant[] = [
      {
        content_hash: null,
        decision_date: null,
        country: "CZE",
        language: "cs",
        redacted_at: null,
      },
      {
        content_hash: "abc",
        decision_date: "2000-01-01",
        country: "SVK",
        language: "sk",
        redacted_at: null,
      },
      {
        content_hash: "def",
        decision_date: "infinity",
        country: "CZE",
        language: "cs",
        redacted_at: "2026-01-01T00:00:00+00:00",
      },
      {
        content_hash: "ghi",
        decision_date: "-infinity",
        country: "CZE",
        language: "cs",
        redacted_at: null,
      },
    ];
    const base = await insertDecision();
    const comparisons = await rows(sql`
      SELECT case_law_provision_extraction_input_digest(decision) =
        case_law_provision_extraction_input_digest(
          decision."content_hash", decision."decision_date",
          decision."country"::text, decision."language"::text,
          decision."redacted_at" IS NULL
        ) AS equal
      FROM case_law_decisions stored
      CROSS JOIN LATERAL jsonb_array_elements(${JSON.stringify(variants)}::text::jsonb)
        WITH ORDINALITY AS variant(value, position)
      CROSS JOIN LATERAL jsonb_populate_record(stored, variant.value) AS decision
      WHERE stored.id = ${base}
      ORDER BY variant.position
    `);
    expect(comparisons.map((row) => row["equal"])).toEqual(
      variants.map(() => true),
    );
  });

  test("pins its versioned encoding: day offset, null, redaction flag", async () => {
    const [dated, undated] = await variantDigests([
      {
        content_hash: "abc",
        decision_date: "2020-03-01",
        country: "CZE",
        language: "cs",
        redacted_at: null,
      },
      {
        content_hash: null,
        decision_date: null,
        country: "CZE",
        language: "cs",
        redacted_at: "2026-01-01T00:00:00+00:00",
      },
    ]);
    const dayOffset = (Date.UTC(2020, 2, 1) - EPOCH_2000) / DAY_MS;
    expect(dated).toBe(
      hashSha256Hex(
        `["case-law-provision-extraction-input/1", "abc", ${String(dayOffset)}, "CZE", "cs", true]`,
      ),
    );
    expect(undated).toBe(
      hashSha256Hex(
        `["case-law-provision-extraction-input/1", null, null, "CZE", "cs", false]`,
      ),
    );
  });

  /**
   * Equal digests exactly for equal inputs (null, empty, finite and both
   * infinite dates among them), and the same digest under every DateStyle
   * and TimeZone a session may carry.
   */
  test("is injective on its inputs and independent of session settings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(inputVariant, { minLength: 2, maxLength: 8 }),
        fc.constantFrom(...SESSION_SETTINGS),
        async (variants, settings) => {
          const reference = await variantDigests(variants);
          expect(
            await withSessionSettings(
              settings,
              async () => await variantDigests(variants),
            ),
          ).toEqual(reference);
          for (const [index, variant] of variants.entries()) {
            for (const [otherIndex, other] of variants.entries()) {
              expect(reference[index] === reference[otherIndex]).toBe(
                canonicalInputs(variant) === canonicalInputs(other),
              );
            }
          }
        },
      ),
      config(40),
    );
  });

  test("keeps both infinities and NULL apart from every finite date", async () => {
    const digests = await variantDigests(
      [null, "infinity", "-infinity", "2000-01-01", "1999-12-31"].map(
        (decisionDate) => ({
          content_hash: "a".repeat(64),
          decision_date: decisionDate,
          country: "CZE",
          language: "cs",
          redacted_at: null,
        }),
      ),
    );
    expect(new Set(digests).size).toBe(5);
  });
});

describe("provision citation correction shape", () => {
  test("stores a distinct printed identity only for a correction", async () => {
    const decisionId = await insertDecision();
    type CitationInsertOptions = {
      selection: "text" | "misprint-correction";
      printedWorkIdentifier: string | null;
      spanStart: number;
    };
    const insert = async ({
      selection,
      printedWorkIdentifier,
      spanStart,
    }: CitationInsertOptions) =>
      await run(sql`
        INSERT INTO case_law_provision_citations (
          id, decision_id, jurisdiction, work_identifier, work_number,
          work_year, work_collection, unit, section, anchor,
          sentence_text, span_start, span_end, confidence, selection,
          printed_work_identifier
        ) VALUES (
          ${createSafeId<"caseLawProvisionCitation">()}, ${decisionId}, 'CZE',
          '100/2020 Sb.', 100, 2020, 'Sb.', 'section', 1, 'section-1',
          '§ 1', ${spanStart}, ${spanStart + 3}, 1, ${selection},
          ${printedWorkIdentifier}
        )
      `);

    await insert({
      selection: "misprint-correction",
      printedWorkIdentifier: "101/2020 Sb.",
      spanStart: 0,
    });
    expect(
      await refusal(
        insert({
          selection: "misprint-correction",
          printedWorkIdentifier: null,
          spanStart: 10,
        }),
      ),
    ).toContain("provision_citations_misprint_correction_shape");
    expect(
      await refusal(
        insert({
          selection: "misprint-correction",
          printedWorkIdentifier: "100/2020 Sb.",
          spanStart: 20,
        }),
      ),
    ).toContain("provision_citations_misprint_correction_shape");
    expect(
      await refusal(
        insert({
          selection: "text",
          printedWorkIdentifier: "101/2020 Sb.",
          spanStart: 30,
        }),
      ),
    ).toContain("provision_citations_misprint_correction_shape");
  });
});

describe("enqueue trigger", () => {
  test("reads exactly the digest's inputs", async () => {
    const triggerColumns = await rows(sql`
      SELECT attribute.attname AS column
      FROM pg_trigger trigger
      JOIN pg_attribute attribute
        ON attribute.attrelid = trigger.tgrelid AND attribute.attnum = ANY (trigger.tgattr::int2[])
      WHERE trigger.tgname = 'case_law_decision_provision_extraction_enqueue'
      ORDER BY 1
    `);
    const { definition } = await one(sql`
      SELECT pg_get_functiondef('case_law_provision_extraction_input_digest(case_law_decisions)'::regprocedure) AS definition
    `);
    const digestColumns = [
      ...new Set(
        [...String(definition).matchAll(/decision\."([a-z_]+)"/gu)].map(
          (match) => match[1] ?? "",
        ),
      ),
    ].toSorted((left, right) => Number(left > right) - Number(left < right));
    expect(triggerColumns.map((row) => row["column"])).toEqual(digestColumns);
    expect(digestColumns).toEqual([
      "content_hash",
      "country",
      "decision_date",
      "language",
      "redacted_at",
    ]);
  });

  test("enqueues an in-scope insert as fresh input work", async () => {
    const id = await insertDecision();
    expect(await readState(id)).toMatchObject({
      lane: "fresh",
      enqueueReason: "input",
      jurisdiction: "CZE",
      workStatus: "eligible",
      digestIsCurrent: true,
    });
    expect((await readState(id))?.dueAt).not.toBeNull();
  });

  test("records an unseen key as a retired scope and enqueues nothing", async () => {
    const id = await insertDecision({ country: "POL", language: "pl" });
    expect(await readState(id)).toBeNull();
    expect(
      await rows(sql`
        SELECT status, generation FROM case_law_provision_extraction_scopes
        WHERE country = 'POL' AND language = 'pl'
      `),
    ).toEqual([{ status: "retired", generation: 1 }]);
  });

  /**
   * Every subset of the five inputs, each column either rewritten with its
   * own value or given a new one: the state is owed work again exactly when
   * the digest moved. Both keys stay in active scopes, so this isolates the
   * digest comparison from scope routing.
   */
  test("makes the state due iff the input digest changed", async () => {
    // A redacted row holds no content hash, so the base has none and a plan
    // never gives it one while redacting.
    const VALUES = {
      content_hash: [null, "b".repeat(64)],
      decision_date: ["2020-03-01", "2021-05-05"],
      country: ["CZE", "SVK"],
      language: ["cs", "sk"],
      redacted_at: [null, "2026-01-01T00:00:00Z"],
    } as const satisfies Record<string, readonly [unknown, unknown]>;
    const COLUMNS = [
      "content_hash",
      "decision_date",
      "country",
      "language",
      "redacted_at",
    ] as const satisfies readonly (keyof typeof VALUES)[];
    const edit = fc.constantFrom("same", "new", "untouched");
    const plans = fc
      .record({
        content_hash: edit,
        decision_date: edit,
        country: edit,
        language: edit,
        redacted_at: edit,
      })
      .filter(
        (plan) => !(plan.content_hash === "new" && plan.redacted_at === "new"),
      );
    await setScope("CZE", "sk", "active");
    await setScope("SVK", "cs", "active");
    await fc.assert(
      fc.asyncProperty(plans, async (plan) => {
        const id = await insertDecision({ contentHash: null });
        await settle(id);
        const before = await digestOf(id);
        const assignments = COLUMNS.filter(
          (column) => plan[column] !== "untouched",
        ).map((column) => {
          const [original, next] = VALUES[column];
          const value = plan[column] === "same" ? original : next;
          return sql`${sql.identifier(column)} = ${value}`;
        });
        if (assignments.length > 0) {
          await run(sql`
            UPDATE case_law_decisions SET ${sql.join(assignments, sql`, `)}
            WHERE id = ${id}
          `);
        }
        const digestChanged = (await digestOf(id)) !== before;
        expect(digestChanged).toBe(
          COLUMNS.some((column) => plan[column] === "new"),
        );
        const state = await readState(id);
        expect(state?.dueAt !== null).toBe(digestChanged);
        expect(state?.digestIsCurrent).toBe(true);
      }),
      config(60),
    );
  });

  test("never enqueues for columns outside the digest", async () => {
    const id = await insertDecision();
    await settle(id);
    await db.execute(sql`
      UPDATE case_law_decisions
      SET metadata = '{"x": 1}'::jsonb, case_number = 'renamed', updated_at = now()
      WHERE id = ${id}
    `);
    expect((await readState(id))?.dueAt).toBeNull();
  });

  test("moves the state's jurisdiction with the decision's country", async () => {
    const id = await insertDecision();
    await setScope("SVK", "cs", "active");
    await db.execute(
      sql`UPDATE case_law_decisions SET country = 'SVK' WHERE id = ${id}`,
    );
    expect(await readState(id)).toMatchObject({
      jurisdiction: "SVK",
      digestIsCurrent: true,
    });
  });

  test("takes the lane from the transaction setting, and fresh after it", async () => {
    const backfilled = createSafeId<"caseLawDecision">();
    await inTransaction([
      sql`SET LOCAL stella.provision_extraction_lane = 'backfill'`,
      decisionInsert(backfilled),
    ]);
    expect((await readState(backfilled))?.lane).toBe("backfill");

    // The same session, after the setting's transaction: it now reads as ''.
    const ordinary = await insertDecision();
    expect((await readState(ordinary))?.lane).toBe("fresh");

    expect(
      await refusal(
        inTransaction([
          sql`SET LOCAL stella.provision_extraction_lane = 'bulk'`,
          decisionInsert(createSafeId<"caseLawDecision">()),
        ]),
      ),
    ).toMatch(/provision_extraction_lane must be/u);
  });

  test("never demotes outstanding work, and completed work keeps no rank", async () => {
    const outstanding = await insertDecision();
    const completed = await insertDecision();
    await settle(completed);
    await inTransaction([
      sql`SET LOCAL stella.provision_extraction_lane = 'backfill'`,
      sql`
        UPDATE case_law_decisions SET decision_date = '2021-01-01'
        WHERE id IN (${outstanding}, ${completed})
      `,
    ]);
    expect((await readState(outstanding))?.lane).toBe("fresh");
    expect((await readState(completed))?.lane).toBe("backfill");

    // A fresh enqueue raises a queued backfill item.
    await db.execute(
      sql`UPDATE case_law_decisions SET decision_date = '2022-01-01' WHERE id = ${completed}`,
    );
    expect((await readState(completed))?.lane).toBe("fresh");
  });

  test("a changed input clears retries, attempts, the lease and a block", async () => {
    const id = await insertDecision();
    await db.execute(sql`
      UPDATE case_law_provision_extractions
      SET work_status = 'retry_scheduled', retry_not_before = now() + interval '1 hour',
          failure_attempts = 3, transient_attempts = 2, last_failure_kind = 'timeout',
          lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes'
      WHERE decision_id = ${id}
    `);
    await db.execute(
      sql`UPDATE case_law_decisions SET decision_date = '2021-06-01' WHERE id = ${id}`,
    );
    expect(await readState(id)).toMatchObject({
      workStatus: "eligible",
      retryNotBefore: null,
      failureAttempts: 0,
      transientAttempts: 0,
      leaseToken: null,
      digestIsCurrent: true,
    });

    await db.execute(sql`
      UPDATE case_law_provision_extractions
      SET work_status = 'blocked', blocked_input_digest = desired_input_digest, due_at = NULL
      WHERE decision_id = ${id}
    `);
    await db.execute(
      sql`UPDATE case_law_decisions SET decision_date = '2021-06-02' WHERE id = ${id}`,
    );
    expect((await readState(id))?.workStatus).toBe("eligible");
  });

  test("owes cleanup when a decision with state leaves every active scope", async () => {
    const id = await insertDecision();
    await settle(id);
    await db.execute(
      sql`UPDATE case_law_decisions SET language = 'en' WHERE id = ${id}`,
    );
    const state = await readState(id);
    expect(state).toMatchObject({
      lane: "repair",
      enqueueReason: "scope_retired",
      digestIsCurrent: true,
    });
    expect(state?.dueAt).not.toBeNull();
  });

  test("only enqueues: provision rows and the published side stay as they were", async () => {
    const id = await insertDecision();
    await db.execute(sql`
      INSERT INTO case_law_provision_citations (
        id, decision_id, jurisdiction, work_identifier, work_number, work_year,
        work_collection, unit, section, anchor, sentence_text, span_start, span_end, confidence
      ) VALUES (
        gen_random_uuid(), ${id}, 'CZE', '89/2012 Sb.', 89, 2012, 'Sb.', 'section', 1,
        'p1', 'Citation', 0, 5, 1
      )
    `);
    await db.execute(sql`
      UPDATE case_law_provision_extractions
      SET generation = 1, outcome = 'terminal', terminal_reason = 'withheld',
          published_input_digest = desired_input_digest, published_at = now(), due_at = NULL
      WHERE decision_id = ${id}
    `);
    await db.execute(sql`
      UPDATE case_law_decisions SET decision_date = '2019-01-01', language = 'en' WHERE id = ${id}
    `);
    expect(
      await one(sql`
        SELECT count(*)::int AS citations,
          (SELECT generation FROM case_law_provision_extractions WHERE decision_id = ${id})::int AS generation,
          (SELECT outcome FROM case_law_provision_extractions WHERE decision_id = ${id}) AS outcome
        FROM case_law_provision_citations WHERE decision_id = ${id}
      `),
    ).toEqual({ citations: 1, generation: 1, outcome: "terminal" });

    const { definition } = await one(sql`
      SELECT pg_get_functiondef('enqueue_case_law_provision_extraction()'::regprocedure) AS definition
    `);
    expect(String(definition)).not.toMatch(
      /\bDELETE\b|published_|"generation"\s*=|"outcome"/iu,
    );
  });
});

describe("ensure_case_law_provision_extraction_state", () => {
  test("seeds in-scope decisions once, and nothing out of scope", async () => {
    const inScope = await insertDecision();
    const outOfScope = await insertDecision({ country: "DEU", language: "de" });
    await db.execute(
      sql`DELETE FROM case_law_provision_extractions WHERE decision_id = ${inScope}`,
    );

    expect(await ensure([inScope, outOfScope], "seed")).toBe(1);
    expect(await readState(inScope)).toMatchObject({
      lane: "backfill",
      enqueueReason: "seed",
      digestIsCurrent: true,
    });
    expect(await readState(outOfScope)).toBeNull();
    expect(await ensure([inScope, outOfScope], "seed")).toBe(0);
  });

  test("reconciles only a missing or outdated digest", async () => {
    const current = await insertDecision();
    const outdated = await insertDecision();
    await settle(current);
    await settle(outdated);
    await db.execute(sql`
      UPDATE case_law_provision_extractions SET desired_input_digest = sha256('stale'::bytea)
      WHERE decision_id = ${outdated}
    `);
    expect(await ensure([current, outdated], "reconcile")).toBe(1);
    expect(await readState(outdated)).toMatchObject({
      lane: "repair",
      enqueueReason: "reconcile",
      digestIsCurrent: true,
    });
    expect((await readState(current))?.dueAt).toBeNull();
  });

  test("activation re-enqueues terminal work, never a current extraction or an unchanged block", async () => {
    const terminal = await insertDecision();
    const extracted = await insertDecision();
    const blocked = await insertDecision();
    await db.execute(sql`
      INSERT INTO case_law_provision_extraction_revisions_registry
        (revision, jurisdiction, engine_input_digest, profile_digest, projection_revision)
      VALUES (1, 'CZE', ${"0".repeat(64)}, ${"1".repeat(64)}, 1)
      ON CONFLICT ON CONSTRAINT case_law_provision_extraction_revisions_registry_pkey DO NOTHING
    `);
    await db.execute(sql`
      UPDATE case_law_provision_extractions
      SET generation = 1, outcome = 'terminal', terminal_reason = 'out_of_scope',
          published_input_digest = desired_input_digest, published_at = now(), due_at = NULL
      WHERE decision_id = ${terminal}
    `);
    await db.execute(sql`
      UPDATE case_law_provision_extractions
      SET generation = 1, outcome = 'extracted_zero', row_count = 0, rows_digest = ${"2".repeat(64)},
          published_projection_digest = sha256('p'::bytea), published_revision = 1,
          published_jurisdiction = 'CZE', published_input_digest = desired_input_digest,
          published_at = now(), due_at = NULL
      WHERE decision_id = ${extracted}
    `);
    await db.execute(sql`
      UPDATE case_law_provision_extractions
      SET work_status = 'blocked', blocked_input_digest = desired_input_digest, due_at = NULL
      WHERE decision_id = ${blocked}
    `);
    expect(await ensure([terminal, extracted, blocked], "activate")).toBe(1);
    expect(await readState(terminal)).toMatchObject({
      enqueueReason: "scope_activated",
    });
    expect((await readState(extracted))?.dueAt).toBeNull();
    expect((await readState(blocked))?.workStatus).toBe("blocked");
  });

  test("retirement enqueues cleanup only for state outside every active scope", async () => {
    const staying = await insertDecision();
    const leaving = await insertDecision({ country: "SVK", language: "sk" });
    await settle(staying);
    await settle(leaving);
    await setScope("SVK", "sk", "retired");
    expect(await ensure([staying, leaving], "retire")).toBe(1);
    expect(await readState(leaving)).toMatchObject({
      lane: "repair",
      enqueueReason: "scope_retired",
    });
    expect((await readState(staying))?.dueAt).toBeNull();
    // Already owed: a second retirement pass writes nothing.
    expect(await ensure([staying, leaving], "retire")).toBe(0);
  });

  test("refuses an unknown action", async () => {
    expect(await refusal(ensure([await insertDecision()], "purge"))).toMatch(
      /unknown provision extraction state action/u,
    );
  });
});

describe("state CHECKs", () => {
  const publish = async (id: DecisionId, assignments: SQL) =>
    await run(sql`
      UPDATE case_law_provision_extractions SET ${assignments} WHERE decision_id = ${id}
    `);

  test("bind a revision iff an extraction was published", async () => {
    const id = await insertDecision();
    await db.execute(sql`
      INSERT INTO case_law_provision_extraction_revisions_registry
        (revision, jurisdiction, engine_input_digest, profile_digest, projection_revision)
      VALUES (1, 'CZE', ${"0".repeat(64)}, ${"1".repeat(64)}, 1)
      ON CONFLICT ON CONSTRAINT case_law_provision_extraction_revisions_registry_pkey DO NOTHING
    `);
    const terminalWithBinding = sql`generation = 1, outcome = 'terminal', terminal_reason = 'withheld',
      published_input_digest = desired_input_digest, published_at = now(),
      published_revision = 1, published_jurisdiction = 'CZE'`;
    const extractedWithoutBinding = sql`generation = 1, outcome = 'extracted_zero', row_count = 0,
      rows_digest = ${"2".repeat(64)}, published_projection_digest = sha256('p'::bytea),
      published_input_digest = desired_input_digest, published_at = now()`;
    const halfBinding = sql`generation = 1, outcome = 'extracted_zero', row_count = 0,
      rows_digest = ${"2".repeat(64)}, published_projection_digest = sha256('p'::bytea),
      published_input_digest = desired_input_digest, published_at = now(),
      published_revision = 1`;
    for (const invalid of [
      terminalWithBinding,
      extractedWithoutBinding,
      halfBinding,
    ]) {
      expect(await refusal(publish(id, invalid))).toMatch(/binding_shape/u);
    }
    await publish(
      id,
      sql`generation = 1, outcome = 'extracted_with_rows', row_count = 2,
        rows_digest = ${"2".repeat(64)}, published_projection_digest = sha256('p'::bytea),
        published_input_digest = desired_input_digest, published_at = now(),
        published_revision = 1, published_jurisdiction = 'CZE'`,
    );
  });
});

describe("scope and revision guards", () => {
  test("scope rows are never deleted and transitions advance the generation", async () => {
    expect(
      await refusal(
        run(
          sql`DELETE FROM case_law_provision_extraction_scopes WHERE country = 'CZE'`,
        ),
      ),
    ).toMatch(/never deleted/u);
    expect(
      await refusal(
        run(
          sql`UPDATE case_law_provision_extraction_scopes SET status = 'retired' WHERE country = 'CZE' AND language = 'cs'`,
        ),
      ),
    ).toMatch(/advance the generation/u);
  });

  test("the registry is immutable and revisions never decrease", async () => {
    for (const revision of [1, 2, 3]) {
      await db.execute(sql`
        INSERT INTO case_law_provision_extraction_revisions_registry
          (revision, jurisdiction, engine_input_digest, profile_digest, projection_revision)
        VALUES (${revision}, 'SVK', ${"0".repeat(64)}, ${"1".repeat(64)}, 1)
      `);
    }
    expect(
      await refusal(
        run(
          sql`UPDATE case_law_provision_extraction_revisions_registry SET profile_digest = ${"f".repeat(64)} WHERE jurisdiction = 'SVK'`,
        ),
      ),
    ).toMatch(/immutable/u);
    expect(
      await refusal(
        run(
          sql`DELETE FROM case_law_provision_extraction_revisions_registry WHERE jurisdiction = 'SVK'`,
        ),
      ),
    ).toMatch(/immutable/u);

    const setRevision = async (desired: number, minCurrent: number) =>
      await run(
        sql`SELECT set_case_law_provision_extraction_revision('SVK', ${desired}, ${minCurrent})`,
      );
    await setRevision(2, 1);
    await setRevision(3, 2);
    expect(await refusal(setRevision(2, 2))).toMatch(/never decrease/u);
    expect(await refusal(setRevision(3, 1))).toMatch(/never decrease/u);
    // The floor never passes the desired revision, and an unregistered
    // revision cannot be desired.
    expect(await refusal(setRevision(3, 4))).toMatch(/revisions_floor/u);
    expect(await refusal(setRevision(9, 3))).toMatch(/revisions_registry_fk/u);
    expect(
      await refusal(
        run(
          sql`DELETE FROM case_law_provision_extraction_revisions WHERE jurisdiction = 'SVK'`,
        ),
      ),
    ).toMatch(/never deleted/u);
    expect(
      await one(sql`
        SELECT desired_revision AS desired, min_current_revision AS "minCurrent"
        FROM case_law_provision_extraction_revisions WHERE jurisdiction = 'SVK'
      `),
    ).toEqual({ desired: 3, minCurrent: 2 });
  });
});

/**
 * The two invariants text checks cannot hold, held by privileges: no
 * application role inserts state or reads a scope row, and the owner-run
 * functions still do their work when those roles call them.
 */
describe("privileges", () => {
  const APPLICATION_ROLES = [
    "stella",
    "stella_ingestion",
    "stella_caselaw_reader",
    "stella_public_law_reader",
    "stella_case_law_analysis_writer",
    "stella_case_law_analysis_reader",
    "stella_corpus_sample_reader",
  ] as const;

  /** Runs `query` as `role` in a transaction of its own. */
  const asRole = async (role: string, query: SQL) =>
    await inTransaction([sql.raw(`SET LOCAL ROLE ${role}`), query]);

  for (const role of APPLICATION_ROLES) {
    test(`${role} can neither insert state nor read scope rows`, async () => {
      const id = await insertDecision();
      await run(
        sql`DELETE FROM case_law_provision_extractions WHERE decision_id = ${id}`,
      );
      expect(
        await refusal(
          asRole(
            role,
            sql`INSERT INTO case_law_provision_extractions
              (decision_id, jurisdiction, desired_input_digest, lane)
              VALUES (${id}, 'CZE', sha256('x'::bytea), 'fresh')`,
          ),
        ),
      ).toMatch(/permission denied/u);
      expect(
        await refusal(
          asRole(
            role,
            sql`SELECT status FROM case_law_provision_extraction_scopes WHERE status IN ('active')`,
          ),
        ),
      ).toMatch(/permission denied/u);
    });
  }

  test("ingestion's decision writes and calls still create state through the owner-run functions", async () => {
    const id = createSafeId<"caseLawDecision">();
    await asRole(
      "stella_ingestion",
      sql`INSERT INTO case_law_decisions (id, source_id, country, language, court, case_number, decision_date, metadata)
        VALUES (${id}, ${SOURCE_ID}, 'CZE', 'cs', 'Court', ${id}, '2020-03-01', '{}'::jsonb)`,
    );
    expect(await readState(id)).toMatchObject({
      lane: "fresh",
      enqueueReason: "input",
    });

    const unseen = createSafeId<"caseLawDecision">();
    await asRole(
      "stella_ingestion",
      sql`INSERT INTO case_law_decisions (id, source_id, country, language, court, case_number, metadata)
        VALUES (${unseen}, ${SOURCE_ID}, 'CZE', 'xq', 'Court', ${unseen}, '{}'::jsonb)`,
    );
    expect(
      await rows(sql`SELECT status FROM case_law_provision_extraction_scopes
        WHERE country = 'CZE' AND language = 'xq'`),
    ).toEqual([{ status: "retired" }]);

    await run(
      sql`DELETE FROM case_law_provision_extractions WHERE decision_id = ${id}`,
    );
    expect(
      await asRole(
        "stella_ingestion",
        sql`SELECT ensure_case_law_provision_extraction_state(ARRAY[${id}::uuid], 'seed') AS written,
          case_law_provision_extraction_in_scope('CZE', 'cs') AS "inScope",
          case_law_provision_extraction_in_scope('CZE', 'xq') AS "retiredInScope"`,
      ),
    ).toEqual([{ written: 1, inScope: true, retiredInScope: false }]);
    expect(await readState(id)).toMatchObject({ enqueueReason: "seed" });
  });

  test("only ingestion may call ensure; ingestion and the public reader may call the scope predicate", async () => {
    const id = await insertDecision();
    const scopePredicateCallers: ReadonlySet<string> = new Set([
      "stella_ingestion",
      "stella_public_law_reader",
    ]);
    for (const role of APPLICATION_ROLES.filter(
      (name) => name !== "stella_ingestion",
    )) {
      expect(
        await refusal(
          asRole(
            role,
            sql`SELECT ensure_case_law_provision_extraction_state(ARRAY[${id}::uuid], 'reconcile')`,
          ),
        ),
      ).toMatch(/permission denied/u);
    }
    for (const role of APPLICATION_ROLES) {
      const call = asRole(
        role,
        sql`SELECT case_law_provision_extraction_in_scope('CZE', 'cs') AS "inScope"`,
      );
      if (scopePredicateCallers.has(role)) {
        expect(await call).toEqual([{ inScope: true }]);
        continue;
      }
      expect(await refusal(call)).toMatch(/permission denied/u);
    }
  });
});
