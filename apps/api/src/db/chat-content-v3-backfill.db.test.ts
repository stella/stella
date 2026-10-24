import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql, type SQLChunk, TransactionRollbackError } from "drizzle-orm";

import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";
import { rejectionOf } from "@stll/property-testing/rejection";

import { getPgErrorCode } from "@/api/lib/pg-error";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
  type TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import { createBackfillRuntime } from "./backfill-runtime";
import {
  backfillChatContentV3Batch,
  CHAT_CONTENT_V3_SOURCES,
  countChatContentVersions,
  createChatContentV3Repair,
  readChatContentV3Completion,
  resetChatContentV3Checkpoints,
} from "./chat-content-v3-backfill";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

let database: TestDatabase;
setDefaultTimeout(120_000);
beforeAll(async () => {
  database = await getTestDb();
});
afterAll(async () => {
  await releaseTestDb();
});

const THREAD = "00000000-0000-4000-8000-000000000001";
const MESSAGE_1 = "00000000-0000-4000-8000-000000000011";
const MESSAGE_2 = "00000000-0000-4000-8000-000000000012";
const MESSAGE_3 = "00000000-0000-4000-8000-000000000013";
const MESSAGE_4 = "00000000-0000-4000-8000-000000000014";
const REVISION = "00000000-0000-4000-8000-000000000021";
const V1 = { version: 1, data: [{ type: "text", text: "Příloha" }] };
const V2 = { version: 2, data: [{ type: "text", content: "Revision" }] };
const V3 = { version: 3, data: [{ type: "text", content: "Already current" }] };
const NORMAL = { kind: "normal", signals: [] } satisfies Verdict;

// Repairs own transactions; savepoints preserve their commit/rollback semantics
// while the surrounding test rolls the fixture back.
const translateTransactionControl = (query: string) => {
  switch (query) {
    case "BEGIN":
      return "SAVEPOINT chat_content_repair";
    case "COMMIT":
      return "RELEASE SAVEPOINT chat_content_repair";
    case "ROLLBACK":
      return "ROLLBACK TO SAVEPOINT chat_content_repair";
    default:
      return query;
  }
};
const onlineConnection = (transaction: TestDatabaseTransaction) => {
  const run = async (query: string, params: readonly unknown[]) => {
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
    query: async (query: string, params: readonly unknown[] = []) =>
      await run(query, params),
    execute: async (query: string, params: readonly unknown[] = []) => {
      await run(query, params);
    },
    release: () => undefined,
  };
};
type Connection = ReturnType<typeof onlineConnection>;
type BatchWorkOptions = {
  tx: Pick<OnlineMigrationConnection, "execute" | "query">;
  cursor: string | null;
  size: number;
};

const withFixture = async (work: (connection: Connection) => Promise<void>) => {
  const result = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`TRUNCATE chat_messages, chat_threads, database_backfill_states CASCADE`,
        );
        await transaction.execute(
          sql`INSERT INTO "user" (id, name, email) VALUES ('chat-content-test-user', 'Test', 'chat-content@example.invalid')`,
        );
        await transaction.execute(
          sql`INSERT INTO organization (id, name, slug, created_at) VALUES ('chat-content-test-org', 'Test', 'chat-content-test-org', now())`,
        );
        await transaction.execute(
          sql`INSERT INTO chat_threads (id, user_id, organization_id, title) VALUES (${THREAD}, 'chat-content-test-user', 'chat-content-test-org', 'Test')`,
        );
        const connection = onlineConnection(transaction);
        await connection.execute(
          "ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_content_v3_check",
        );
        await connection.execute(
          "ALTER TABLE chat_message_revisions DROP CONSTRAINT IF EXISTS chat_message_revisions_content_v3_check",
        );
        await work(connection);
        transaction.rollback();
      }),
    catch: (error) => error,
  });
  if (result.isErr() && !(result.error instanceof TransactionRollbackError)) {
    throw result.error;
  }
};

const insertMessage = async (
  connection: Connection,
  id: string,
  content: unknown,
) => {
  await connection.execute(
    "INSERT INTO chat_messages (id, thread_id, user_id, role, content) VALUES ($1, $2, 'chat-content-test-user', 'assistant', $3::text::jsonb)",
    [id, THREAD, JSON.stringify(content)],
  );
};
const receipts = async (connection: Connection) =>
  await connection.query(
    "SELECT source, row_id, message_id, from_version, outcome, reason FROM chat_content_v3_backfill_receipts ORDER BY source, row_id",
  );
const contents = async (connection: Connection) =>
  await connection.query("SELECT id, content FROM chat_messages ORDER BY id");
const installGuards = async (connection: Connection) => {
  const migration = await Bun.file(
    new URL(
      "../../drizzle/20261010234000_chat_content_v3_backfill_receipts/migration.sql",
      import.meta.url,
    ),
  ).text();
  const guards = migration
    .split("--> statement-breakpoint")
    .flatMap((statement) => {
      const match =
        /ALTER TABLE "(?<table>[^"]+)" ADD CONSTRAINT "(?<name>[^"]+)"/u.exec(
          statement,
        );
      if (match?.groups === undefined) {
        return [];
      }
      const { table, name } = match.groups;
      if (table === undefined || name === undefined) {
        panic("Backfill write guard migration lacks table or constraint name");
      }
      return [{ table, name, statement }];
    });
  expect(new Set(guards.map(({ table }) => table))).toEqual(
    new Set(Object.values(CHAT_CONTENT_V3_SOURCES).map(({ table }) => table)),
  );
  for (const { table, name, statement } of guards) {
    const existing = await connection.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2",
      [table, name],
    );
    if (existing.length === 0) {
      await connection.execute(statement);
    }
  }
};
const repair = () => {
  const implementation = createChatContentV3Repair({
    readVerdict: async () => NORMAL,
    sleep: async () => undefined,
    log: () => undefined,
  });
  return {
    repair: async (connection: Connection) => {
      await installGuards(connection);
      // The fixture is one rolled-back transaction, so validation runs ungated.
      return await implementation.repair(
        connection,
        createUngatedTableGateForTests(connection),
      );
    },
  };
};

type RejectedWriteOptions = {
  connection: Connection;
  write: () => Promise<void>;
};
const expectCheckViolation = async ({
  connection,
  write,
}: RejectedWriteOptions) => {
  await connection.execute("BEGIN");
  const attempted = await Result.tryPromise(write);
  await connection.execute("ROLLBACK");
  await connection.execute("COMMIT");
  if (attempted.isOk()) {
    panic("Legacy writer unexpectedly bypassed the v3 database constraint");
  }
  expect(getPgErrorCode(attempted.error)).toBe("23514");
};

test("deployment converts messages and revision snapshots; rewalking retains conversion provenance", async () => {
  await withFixture(async (connection) => {
    await insertMessage(connection, MESSAGE_1, V1);
    await insertMessage(connection, MESSAGE_2, V2);
    await insertMessage(connection, MESSAGE_3, V3);
    await connection.execute(
      "INSERT INTO chat_message_revisions (id, message_id, thread_id, revision, content, edit) VALUES ($1, $2, $3, 0, $4::text::jsonb, '{}'::jsonb)",
      [REVISION, MESSAGE_1, THREAD, JSON.stringify(V2)],
    );
    await installGuards(connection);
    expect(await readChatContentV3Completion(connection)).toMatchObject({
      type: "incomplete",
    });
    await repair().repair(connection);
    expect(await contents(connection)).toEqual([
      {
        id: MESSAGE_1,
        content: { version: 3, data: [{ type: "text", content: "Příloha" }] },
      },
      {
        id: MESSAGE_2,
        content: { version: 3, data: [{ type: "text", content: "Revision" }] },
      },
      { id: MESSAGE_3, content: V3 },
    ]);
    expect(
      await connection.query("SELECT content FROM chat_message_revisions"),
    ).toEqual([
      {
        content: { version: 3, data: [{ type: "text", content: "Revision" }] },
      },
    ]);
    const firstReceipts = await receipts(connection);
    expect(firstReceipts).toEqual([
      {
        source: "message",
        row_id: MESSAGE_1,
        message_id: MESSAGE_1,
        from_version: 1,
        outcome: "converted",
        reason: "normalized-and-proved-v3",
      },
      {
        source: "message",
        row_id: MESSAGE_2,
        message_id: MESSAGE_2,
        from_version: 2,
        outcome: "converted",
        reason: "normalized-and-proved-v3",
      },
      {
        source: "message",
        row_id: MESSAGE_3,
        message_id: MESSAGE_3,
        from_version: 3,
        outcome: "skipped",
        reason: "already-v3",
      },
      {
        source: "revision",
        row_id: REVISION,
        message_id: MESSAGE_1,
        from_version: 2,
        outcome: "converted",
        reason: "normalized-and-proved-v3",
      },
    ]);
    await resetChatContentV3Checkpoints(connection);
    await repair().repair(connection);
    expect(await receipts(connection)).toEqual(firstReceipts);
    expect(await readChatContentV3Completion(connection)).toEqual({
      type: "complete",
    });
    for (const legacy of [V1, V2]) {
      await expectCheckViolation({
        connection,
        write: async () => await insertMessage(connection, MESSAGE_4, legacy),
      });
      await expectCheckViolation({
        connection,
        write: async () =>
          await connection.execute(
            "INSERT INTO chat_message_revisions (id, message_id, thread_id, revision, content, edit) VALUES ($1, $2, $3, 1, $4::text::jsonb, '{}'::jsonb)",
            [MESSAGE_4, MESSAGE_1, THREAD, JSON.stringify(legacy)],
          ),
      });
    }
    await insertMessage(connection, MESSAGE_4, V3);
    await connection.execute(
      "INSERT INTO chat_message_revisions (id, message_id, thread_id, revision, content, edit) VALUES ($1, $2, $3, 1, $4::text::jsonb, '{}'::jsonb)",
      [MESSAGE_4, MESSAGE_1, THREAD, JSON.stringify(V3)],
    );
  });
});

test("version census is a dry run with no content, receipt or checkpoint writes", async () => {
  await withFixture(async (connection) => {
    await insertMessage(connection, MESSAGE_1, V1);
    await insertMessage(connection, MESSAGE_2, V2);
    await insertMessage(connection, MESSAGE_3, V3);
    const original = await contents(connection);
    const census = await countChatContentVersions(connection);
    expect(census.at(0)?.versions).toEqual(
      expect.arrayContaining([
        { version: "1", count: "1" },
        { version: "2", count: "1" },
        { version: "3", count: "1" },
      ]),
    );
    expect(census.at(1)).toEqual({ source: "revision", versions: [] });
    expect(await contents(connection)).toEqual(original);
    expect(await receipts(connection)).toEqual([]);
    expect(
      await connection.query("SELECT name FROM database_backfill_states"),
    ).toEqual([]);
  });
});

test("a clean content census requires validated database write guards before completion", async () => {
  await withFixture(async (connection) => {
    await insertMessage(connection, MESSAGE_1, V3);
    expect(
      await rejectionOf(readChatContentV3Completion(connection)),
    ).toMatchObject({
      message: expect.stringContaining(
        "constraint chat_messages_content_v3_check is missing",
      ),
    });
    await installGuards(connection);
    expect(await readChatContentV3Completion(connection)).toMatchObject({
      type: "incomplete",
    });
    await repair().repair(connection);
    expect(await readChatContentV3Completion(connection)).toEqual({
      type: "complete",
    });
  });
});

test("a number beyond double precision fails the row instead of reporting a concurrent change or rounding it", async () => {
  await withFixture(async (connection) => {
    const exact = "12345678901234567890";
    await connection.execute(
      "INSERT INTO chat_messages (id, thread_id, user_id, role, content) VALUES ($1, $2, 'chat-content-test-user', 'assistant', $3::text::jsonb)",
      [
        MESSAGE_1,
        THREAD,
        `{"version":2,"data":[{"id":"call-count","name":"list_templates","type":"tool-call","input":{},"state":"complete","output":{"count":${exact}},"arguments":"{}"}]}`,
      ],
    );
    await insertMessage(connection, MESSAGE_2, V1);
    expect(await rejectionOf(repair().repair(connection))).toMatchObject({
      message: expect.stringContaining("Non-v3 chat content remains"),
    });
    expect(
      await connection.query(
        "SELECT content::text LIKE $1 AS kept FROM chat_messages WHERE id = $2",
        [`%${exact}%`, MESSAGE_1],
      ),
    ).toEqual([{ kept: true }]);
    expect(await receipts(connection)).toContainEqual({
      source: "message",
      row_id: MESSAGE_1,
      message_id: MESSAGE_1,
      from_version: 2,
      outcome: "failed",
      reason: "lossy-json-number",
    });
    expect(await receipts(connection)).toContainEqual({
      source: "message",
      row_id: MESSAGE_2,
      message_id: MESSAGE_2,
      from_version: 1,
      outcome: "converted",
      reason: "normalized-and-proved-v3",
    });
  });
});

test("invalid legacy rows receive durable failures while later rows convert and deployment refuses completion", async () => {
  await withFixture(async (connection) => {
    const invalid = { version: 2, data: [{ type: "text", content: 12 }] };
    const invalidVersion = { version: "3", data: [] };
    const unrecordableVersion = { version: 1e100, data: [] };
    await insertMessage(connection, MESSAGE_1, invalid);
    await insertMessage(connection, MESSAGE_2, invalidVersion);
    await insertMessage(connection, MESSAGE_3, V1);
    await insertMessage(connection, MESSAGE_4, unrecordableVersion);
    expect(await rejectionOf(repair().repair(connection))).toMatchObject({
      message: expect.stringContaining("Non-v3 chat content remains"),
    });
    expect(await contents(connection)).toEqual([
      { id: MESSAGE_1, content: invalid },
      { id: MESSAGE_2, content: invalidVersion },
      {
        id: MESSAGE_3,
        content: { version: 3, data: [{ type: "text", content: "Příloha" }] },
      },
      { id: MESSAGE_4, content: unrecordableVersion },
    ]);
    expect(await receipts(connection)).toContainEqual({
      source: "message",
      row_id: MESSAGE_1,
      message_id: MESSAGE_1,
      from_version: 2,
      outcome: "failed",
      reason: "invalid-legacy-part",
    });
    expect(await receipts(connection)).toContainEqual({
      source: "message",
      row_id: MESSAGE_2,
      message_id: MESSAGE_2,
      from_version: null,
      outcome: "failed",
      reason: "invalid-legacy-content",
    });
    expect(await receipts(connection)).toContainEqual({
      source: "message",
      row_id: MESSAGE_4,
      message_id: MESSAGE_4,
      from_version: null,
      outcome: "failed",
      reason: "invalid-legacy-content",
    });
    expect(
      await connection.query(
        "SELECT cursor FROM database_backfill_states WHERE name = 'chat-content-v3-message'",
      ),
    ).toEqual([{ cursor: null }]);
    expect(await readChatContentV3Completion(connection)).toMatchObject({
      type: "incomplete",
    });
    await connection.execute(
      "UPDATE chat_messages SET content = $1::text::jsonb WHERE id = $2",
      [JSON.stringify({ version: 3, data: V2.data }), MESSAGE_1],
    );
    await connection.execute(
      "UPDATE chat_messages SET content = $1::text::jsonb WHERE id = $2",
      [JSON.stringify(V3), MESSAGE_4],
    );
    expect(await readChatContentV3Completion(connection)).toMatchObject({
      type: "incomplete",
    });
    await connection.execute(
      "UPDATE chat_messages SET content = $1::text::jsonb WHERE id = $2",
      [JSON.stringify(V3), MESSAGE_2],
    );
    await resetChatContentV3Checkpoints(connection);
    await repair().repair(connection);
    expect(await readChatContentV3Completion(connection)).toEqual({
      type: "complete",
    });
    expect(await receipts(connection)).toContainEqual({
      source: "message",
      row_id: MESSAGE_1,
      message_id: MESSAGE_1,
      from_version: 3,
      outcome: "skipped",
      reason: "already-v3",
    });
  });
});

test("interruption rolls back the current batch and a new runtime resumes from the last committed cursor", async () => {
  await withFixture(async (connection) => {
    for (const id of [MESSAGE_1, MESSAGE_2, MESSAGE_3]) {
      await insertMessage(connection, id, V1);
    }
    await installGuards(connection);
    const openRuntime = () =>
      createBackfillRuntime({
        connection,
        name: "chat-content-v3-message",
        tableName: "chat_messages",
        initialSize: 1,
        config: {
          ...defaultConfig,
          minSize: 1,
          maxSize: 1,
          minSleepMs: 0,
          maxSleepMs: 0,
        },
        readVerdict: async () => NORMAL,
        log: () => undefined,
      });
    const work = async ({ tx, cursor, size }: BatchWorkOptions) =>
      await backfillChatContentV3Batch({ tx, cursor, size, source: "message" });
    const runtime = openRuntime();
    try {
      await runtime.step(work);
      expect(
        await rejectionOf(
          runtime.step(async (options) => {
            await work(options);
            panic("simulated interruption after content and receipt writes");
          }),
        ),
      ).toMatchObject({
        message: expect.stringContaining(
          "simulated interruption after content and receipt writes",
        ),
      });
      expect(
        await connection.query(
          "SELECT cursor FROM database_backfill_states WHERE name = 'chat-content-v3-message'",
        ),
      ).toEqual([{ cursor: MESSAGE_1 }]);
      expect(await contents(connection)).toEqual([
        {
          id: MESSAGE_1,
          content: { version: 3, data: [{ type: "text", content: "Příloha" }] },
        },
        { id: MESSAGE_2, content: V1 },
        { id: MESSAGE_3, content: V1 },
      ]);
      expect(await receipts(connection)).toHaveLength(1);
    } finally {
      await runtime.close();
    }
    const resumed = openRuntime();
    try {
      await resumed.step(work);
      expect(
        await connection.query(
          "SELECT cursor FROM database_backfill_states WHERE name = 'chat-content-v3-message'",
        ),
      ).toEqual([{ cursor: MESSAGE_2 }]);
      await resumed.step(work);
      await resumed.step(work);
      expect(await readChatContentV3Completion(connection)).toMatchObject({
        type: "incomplete",
      });
      await repair().repair(connection);
      expect(await readChatContentV3Completion(connection)).toEqual({
        type: "complete",
      });
      expect(await receipts(connection)).toHaveLength(3);
    } finally {
      await resumed.close();
    }
  });
});

test("malformed and unknown v1 and v2 parts retain the original row and record failure without discarding valid neighbors", async () => {
  const invalidMessages = [
    { version: 1, data: [{ type: "text", text: 42 }] },
    {
      version: 1,
      data: [
        { type: "text", text: "retained" },
        { type: "unknown-part", payload: "unrecognized" },
      ],
    },
    { version: 2, data: [{ type: "text", content: 42 }] },
    {
      version: 2,
      data: [
        { type: "text", content: "retained" },
        { type: "unknown-part", payload: "unrecognized" },
      ],
    },
  ];
  for (const invalid of invalidMessages) {
    await withFixture(async (connection) => {
      await insertMessage(connection, MESSAGE_1, invalid);
      await insertMessage(connection, MESSAGE_2, V1);
      expect(await rejectionOf(repair().repair(connection))).toMatchObject({
        message: expect.stringContaining("Non-v3 chat content remains"),
      });
      expect(await contents(connection)).toEqual([
        { id: MESSAGE_1, content: invalid },
        {
          id: MESSAGE_2,
          content: { version: 3, data: [{ type: "text", content: "Příloha" }] },
        },
      ]);
      expect(await receipts(connection)).toContainEqual({
        source: "message",
        row_id: MESSAGE_1,
        message_id: MESSAGE_1,
        from_version: invalid.version,
        outcome: "failed",
        reason: "invalid-legacy-part",
      });
    });
  }
});
