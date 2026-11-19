/**
 * The asserted date backfill loses nothing: it reads only claims still
 * `pending`, writes only their three date columns (what the engine's reader
 * says the words assert), leaves every other column and every claim already
 * dated exactly as stored, resumes after an interrupted pass, and changes
 * nothing when run again.
 */

import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql, type SQLChunk, TransactionRollbackError } from "drizzle-orm";

import type { Verdict } from "@stll/db-load-gate/health";

import {
  assertedDateColumns,
  claimAssertedDate,
} from "@/api/lib/lists/verification/claim-date";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
  type TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import { READ_COMMITTED_BEGIN } from "../lib/db/read-committed-unit";
import { createListClaimAssertedDateBackfill } from "./list-claim-asserted-date-backfill";

let database: TestDatabase;
beforeAll(async () => {
  database = await getTestDb();
});
afterAll(async () => {
  await releaseTestDb();
});

const ORGANIZATION = "asserted-date-backfill-org";
const WORKSPACE = "00000000-0000-4000-8000-0000000000a1";
const DOCUMENT = "00000000-0000-4000-8000-0000000000a2";
const RUN = "00000000-0000-4000-8000-0000000000a3";
const NORMAL = { kind: "normal", signals: [] } satisfies Verdict;

/** Claims as the engine wrote them before dates: every one `pending`. */
const PENDING_TEXTS = [
  "On 10 August 2021 I emailed Mr Novák.",
  "I was abroad from 2 to 20 August 2021.",
  "The next day he called me.",
  "In 2019 and in 2021 the policy changed.",
  "Dne 3. března 2020 jsem podepsal smlouvu.",
  "I believe the board knew.",
  "The invoice No. 2021 was paid in March 2022.",
] as const;

/** A claim already dated by the engine, which the backfill must not read. */
const WRITTEN_TEXT = "On 10 August 2021 I emailed Mr Novák.";

// Repairs own transactions; savepoints preserve their commit/rollback
// semantics while the surrounding test rolls the fixture back.
const translateTransactionControl = (query: string) => {
  switch (query) {
    case "BEGIN":
    case READ_COMMITTED_BEGIN:
      return "SAVEPOINT asserted_date_backfill";
    case "COMMIT":
      return "RELEASE SAVEPOINT asserted_date_backfill";
    case "ROLLBACK":
      return "ROLLBACK TO SAVEPOINT asserted_date_backfill";
    default:
      return query;
  }
};

type Connection = {
  query: (query: string, params?: readonly unknown[]) => Promise<unknown[]>;
  execute: (query: string, params?: readonly unknown[]) => Promise<void>;
  release: () => undefined;
};

const onlineConnection = (
  transaction: TestDatabaseTransaction,
  /** Fails the statement it is given, to interrupt a pass. */
  failOn: (query: string) => boolean = () => false,
): Connection => {
  const run = async (query: string, params: readonly unknown[]) => {
    if (failOn(query)) {
      throw new Error("Interrupted");
    }
    const statement = translateTransactionControl(query);
    const chunks: SQLChunk[] = [];
    for (const [index, segment] of statement.split(/\$(\d+)/gu).entries()) {
      chunks.push(
        index % 2 === 0
          ? sql.raw(segment)
          : sql`${params[Number(segment) - 1]}`,
      );
    }
    return (await transaction.execute(sql.join(chunks))).rows;
  };
  return {
    query: async (query, params = []) => await run(query, params),
    execute: async (query, params = []) => {
      await run(query, params);
    },
    release: () => undefined,
  };
};

const withFixture = async (
  work: (transaction: TestDatabaseTransaction) => Promise<void>,
) => {
  const result = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`RESET ROLE`);
        await transaction.execute(
          sql`TRUNCATE database_backfill_states CASCADE`,
        );
        await transaction.execute(
          sql`INSERT INTO organization (id, name, slug, created_at) VALUES (${ORGANIZATION}, 'Backfill', ${ORGANIZATION}, now())`,
        );
        await transaction.execute(
          sql`INSERT INTO workspaces (id, organization_id, name, reference) VALUES (${WORKSPACE}, ${ORGANIZATION}, 'Backfill matter', 'BF-1')`,
        );
        await transaction.execute(
          sql`INSERT INTO entities (id, workspace_id, name) VALUES (${DOCUMENT}, ${WORKSPACE}, 'Witness statement')`,
        );
        await transaction.execute(
          sql`INSERT INTO legal_list_verification_runs
                (id, organization_id, workspace_id, entity_id, file_field_id, entity_version_id, content_sha256, evidence, status)
              VALUES (${RUN}, ${ORGANIZATION}, ${WORKSPACE}, ${DOCUMENT}, gen_random_uuid(), gen_random_uuid(),
                repeat('f', 64), jsonb_build_object('listId', gen_random_uuid()::text, 'facts', '[]'::jsonb), 'completed')`,
        );
        for (const [position, text] of PENDING_TEXTS.entries()) {
          await transaction.execute(
            sql`INSERT INTO legal_list_claims (id, workspace_id, run_id, position, type, state, text, anchor)
                VALUES (gen_random_uuid(), ${WORKSPACE}, ${RUN}, ${position}, 'fact', 'nocover', ${text},
                  jsonb_build_object('type', 'docx-block', 'blockId', 'p1', 'start', 0, 'end', 1))`,
          );
        }
        // Dated by the grader, though its words would date it themselves:
        // a backfill that read it again would overwrite the grader's answer.
        await transaction.execute(
          sql`INSERT INTO legal_list_claims (id, workspace_id, run_id, position, type, state, text, anchor,
                asserted_on, asserted_on_precision, asserted_on_source)
              VALUES (gen_random_uuid(), ${WORKSPACE}, ${RUN}, ${PENDING_TEXTS.length}, 'fact', 'nocover', ${WRITTEN_TEXT},
                jsonb_build_object('type', 'docx-block', 'blockId', 'p1', 'start', 0, 'end', 1),
                '2021-01-01', 'year', 'grader')`,
        );
        await work(transaction);
        transaction.rollback();
      }),
    catch: (error) => error,
  });
  if (result.isErr() && !(result.error instanceof TransactionRollbackError)) {
    throw result.error;
  }
};

type ClaimSnapshot = {
  id: string;
  rest: string;
  text: string;
  asserted_on: string | null;
  asserted_on_precision: string | null;
  asserted_on_source: string;
};

/** Every claim: its asserted date columns, and every other column as JSON. */
const snapshot = async (transaction: TestDatabaseTransaction) =>
  (
    await transaction.execute(
      sql`SELECT id::text AS id, text,
            asserted_on::text AS asserted_on, asserted_on_precision, asserted_on_source,
            (to_jsonb(claim) - 'asserted_on' - 'asserted_on_precision' - 'asserted_on_source')::text AS rest
          FROM legal_list_claims claim WHERE run_id = ${RUN} ORDER BY position`,
    )
  ).rows.map((row) => asTestRaw<ClaimSnapshot>(row));

const backfill = (batchSize: number) =>
  createListClaimAssertedDateBackfill({
    readVerdict: async () => NORMAL,
    sleep: async () => {},
    log: () => undefined,
    batchSize,
  });

const run = async (connection: Connection, batchSize = 2) =>
  await backfill(batchSize).repair(connection);

const expected = (row: ClaimSnapshot) => {
  const columns = assertedDateColumns(claimAssertedDate(row.text, null));
  return {
    asserted_on: columns.assertedOn,
    asserted_on_precision: columns.assertedOnPrecision,
    asserted_on_source: columns.assertedOnSource,
  };
};

test("pending claims get their words' date, and nothing else changes", async () => {
  await withFixture(async (transaction) => {
    const before = await snapshot(transaction);
    // The fixture reaches the fault: rows are pending and the reader dates
    // some of them, so a backfill that wrote nothing would fail below.
    expect(
      before.filter((row) => row.asserted_on_source === "pending"),
    ).toHaveLength(PENDING_TEXTS.length);
    expect(
      PENDING_TEXTS.filter(
        (text) => claimAssertedDate(text, null).type === "dated",
      ).length,
    ).toBeGreaterThan(0);

    const connection = onlineConnection(transaction);
    expect((await backfill(2).readCompletion(connection)).type).toBe(
      "incomplete",
    );
    expect(await run(connection)).toEqual({ type: "complete" });
    expect(await backfill(2).readCompletion(connection)).toEqual({
      type: "complete",
    });

    const after = await snapshot(transaction);
    expect(after.map(({ id, rest, text }) => ({ id, rest, text }))).toEqual(
      before.map(({ id, rest, text }) => ({ id, rest, text })),
    );
    expect(after).toEqual(
      before.map((row) =>
        row.asserted_on_source === "pending"
          ? { ...row, ...expected(row) }
          : row,
      ),
    );

    // Run again: there is nothing left to read, so nothing changes.
    expect(await run(connection)).toEqual({ type: "complete" });
    expect(await snapshot(transaction)).toEqual(after);
  });
});

test("an interrupted pass resumes where it stopped", async () => {
  await withFixture(async (transaction) => {
    let updates = 0;
    const interrupted = onlineConnection(transaction, (query) => {
      if (!query.includes("UPDATE public.legal_list_claims")) {
        return false;
      }
      updates += 1;
      return updates > 1;
    });
    expect(
      await run(interrupted).then(
        () => "finished",
        () => "interrupted",
      ),
    ).toBe("interrupted");
    const partial = await snapshot(transaction);
    const pending = partial.filter(
      (row) => row.asserted_on_source === "pending",
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThan(PENDING_TEXTS.length);

    const connection = onlineConnection(transaction);
    expect(await run(connection)).toEqual({ type: "complete" });
    const after = await snapshot(transaction);
    expect(after.some((row) => row.asserted_on_source === "pending")).toBe(
      false,
    );
    const written = after.at(-1);
    expect(written).toMatchObject({
      asserted_on: "2021-01-01",
      asserted_on_precision: "year",
      asserted_on_source: "grader",
    });
  });
});
