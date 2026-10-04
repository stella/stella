import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import {
  APPROVAL_TOOL_NAME,
  approvalToolArguments,
  PLAIN_TOOL_ARGUMENTS,
  PLAIN_TOOL_NAME,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Chat threads as earlier releases stored them. Each fixture in
// `SAVED_STATE_DIR` holds the rows one release's code wrote for the same
// scripted conversation (`writeSavedStateConversation`), as `to_jsonb` of each
// row, so a fixture carries exactly the columns and JSON that release wrote.
// `loadSavedState` puts a fixture into the current schema the way production
// holds it: the chat data migrations that ran after the release are applied
// to its rows. See the README next to the fixtures.

export const SAVED_STATE_DIR = path.resolve(
  import.meta.dir,
  "../../handlers/chat/__fixtures__/saved-state",
);

export const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../../../drizzle");

/** The tables a chat thread's saved state lives in, in insert order. */
const SAVED_STATE_TABLES = [
  "chat_threads",
  "chat_messages",
  "chat_turns",
  "chat_thread_names",
] as const;
type SavedStateTable = (typeof SAVED_STATE_TABLES)[number];

type SavedRow = Record<string, unknown>;
export type SavedStateRows = Partial<Record<SavedStateTable, SavedRow[]>>;

export type SavedStateFixture = {
  /** The release that wrote the rows, or null for unreleased main. */
  release: string | null;
  /** The commit whose code wrote the rows. */
  sourceCommit: string;
  /** The newest migration that commit shipped: every chat data migration
   *  after it still has to run on these rows. */
  newestMigration: string;
  /** What this release's stored shape adds or drops. */
  shape: string;
  /** The ids the writing run's organization and user had. */
  actors: { organizationId: string; userId: string };
  threadId: string;
  /** The approval-gated call the thread still waits on. */
  pendingToolCallId: string;
  /**
   * Defects the release itself stored, as `<oracle> <tool call>`: the
   * harness reports each one on the loaded thread, and continuing the
   * thread must add none.
   */
  storedDefects?: string[] | undefined;
  rows: SavedStateRows;
};

/**
 * Migrations that only rewrite stored rows, chat rows among them. Loading a
 * fixture replays each one newer than the fixture's `newestMigration`, as the
 * deploys after that release did. `findUnlistedChatDataMigrations` fails when
 * a migration rewrites chat rows and is missing here.
 */
const CHAT_DATA_MIGRATIONS: readonly string[] = [
  "20260905210000_chat_matter_document_tool_rename",
  "20260907170000_folio_block_ids_in_range",
];

/** Migrations newer than `since` that write rows of a chat table and are
 *  missing from `CHAT_DATA_MIGRATIONS`. */
export const findUnlistedChatDataMigrations = (since: string): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((name) => name > since && !CHAT_DATA_MIGRATIONS.includes(name))
    .filter((name) =>
      statementsOf(name).some((statement) =>
        SAVED_STATE_TABLES.some((table) =>
          new RegExp(
            String.raw`\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(ONLY\s+)?("?public"?\.)?"?${table}"?(\s|\(|$)`,
            "imu",
          ).test(statement),
        ),
      ),
    );

/** A migration's statements with comment lines removed, without the
 *  session settings (`SET ...`) that only bound the deploy. */
const statementsOf = (migration: string): string[] =>
  readFileSync(path.join(MIGRATIONS_DIR, migration, "migration.sql"), "utf-8")
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement !== "" && !/^SET\s/iu.test(statement));

export const readSavedStateFixtures = (): SavedStateFixture[] =>
  readdirSync(SAVED_STATE_DIR)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) =>
      asTestRaw<SavedStateFixture>(
        JSON.parse(readFileSync(path.join(SAVED_STATE_DIR, name), "utf-8")),
      ),
    );

// --- Writing -----------------------------------------------------------------

/** What writing the conversation needs from a chat harness. */
export type SavedStateWriter = Pick<
  ChatHarness,
  "approveContext" | "lastAssistant" | "script" | "send" | "sendContext"
>;

const PENDING_TOOL_CALL_ID = "call-lease";

/**
 * The conversation every fixture stores, sent through the release's own send
 * path with a scripted model: a text answer, a server tool that runs without
 * asking, an approved call, a denied call, a provider failure, and an
 * approval the thread is left waiting on. Returns the pending call's id.
 */
export const writeSavedStateConversation = async (
  harness: SavedStateWriter,
  threadId: SafeId<"chatThread">,
): Promise<string> => {
  const userSays = async (text: string) => {
    const runId = `run-${Bun.randomUUIDv7()}`;
    const outcome = await harness.send(
      harness.sendContext({
        message: {
          id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
          parts: [{ content: text, type: "text" }],
          role: "user",
        },
        runId,
        threadId,
      }),
    );
    if (outcome.status !== "streamed") {
      return panic(`The send was rejected: ${Bun.inspect(outcome)}`);
    }
    return runId;
  };
  const answer = async ({
    approved,
    runId,
  }: {
    approved: boolean;
    runId: string;
  }) => {
    const pending = await harness.lastAssistant(threadId);
    const outcome = await harness.send(
      harness.approveContext({
        approved,
        call: pendingApprovalCallOf(pending.parts),
        interruptedRunId: runId,
        messageId: pending.id,
        parts: pending.parts,
        threadId,
      }),
    );
    if (outcome.status !== "streamed") {
      panic(`The answer was rejected: ${Bun.inspect(outcome)}`);
    }
  };
  const approvalCall = (toolCallId: string, name: string) =>
    ({
      arguments: approvalToolArguments(name),
      toolCallId,
      toolName: APPROVAL_TOOL_NAME,
      type: "tool-call",
    }) as const;
  const text = (content: string) =>
    ({ finishReason: "stop", text: content, type: "text" }) as const;

  harness.script(threadId, [text("The matter concerns a commercial lease.")]);
  await userSays("What is this matter about?");

  harness.script(threadId, [
    {
      arguments: PLAIN_TOOL_ARGUMENTS,
      toolCallId: "call-templates",
      toolName: PLAIN_TOOL_NAME,
      type: "tool-call",
    },
    text("There are no templates yet."),
  ]);
  await userSays("Which templates do we have?");

  harness.script(threadId, [approvalCall("call-draft", "draft")]);
  const draftRun = await userSays("Delete the old draft.");
  harness.script(threadId, [text("The old draft is deleted.")]);
  await answer({ approved: true, runId: draftRun });

  harness.script(threadId, [approvalCall("call-memo", "memo")]);
  const memoRun = await userSays("Delete the memo.");
  harness.script(threadId, [text("I kept the memo.")]);
  await answer({ approved: false, runId: memoRun });

  harness.script(threadId, [
    {
      code: "overloaded",
      message: "The provider is overloaded",
      type: "error",
    },
  ]);
  await userSays("Summarize the lease.");

  harness.script(threadId, [approvalCall(PENDING_TOOL_CALL_ID, "lease")]);
  await userSays("Delete the lease.");
  return PENDING_TOOL_CALL_ID;
};

/** Every row of `threadId` in the saved-state tables, as `to_jsonb` spells
 *  it, oldest first. A table the schema lacks is left out. */
export const dumpSavedState = async (
  db: TestDatabase,
  threadId: string,
): Promise<SavedStateRows> => {
  const rows: SavedStateRows = {};
  for (const table of SAVED_STATE_TABLES) {
    const exists = await db.execute<{ present: boolean }>(
      sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`,
    );
    if (exists.rows[0]?.present !== true) {
      continue;
    }
    const key = table === "chat_threads" ? "id" : "thread_id";
    const order =
      table === "chat_thread_names" ? sql`kind, name` : sql`created_at, id`;
    const result = await db.execute<{ row: SavedRow }>(
      sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t WHERE ${sql.identifier(key)} = ${threadId}::uuid ORDER BY ${order}`,
    );
    rows[table] = result.rows.map(({ row }) => row);
  }
  return rows;
};

// --- Shape ------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const keysOf = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  return isRecord(value)
    ? Object.keys(value).toSorted().join(",")
    : typeof value;
};

const partShape = (role: unknown, part: unknown): string => {
  if (!isRecord(part)) {
    return `${String(role)} part ${typeof part}`;
  }
  const base = `${String(role)} ${String(part["type"])} {${keysOf(part)}}`;
  switch (part["type"]) {
    case "tool-call": {
      return `${base} state=${String(part["state"])} input=${keysOf(part["input"])} approval=${keysOf(part["approval"])}:${String(isRecord(part["approval"]) ? part["approval"]["approved"] : undefined)} output=${keysOf(part["output"])} metadata=${keysOf(part["metadata"])}`;
    }
    case "tool-result": {
      return `${base} state=${String(part["state"])} content=${isRecord(part["content"]) ? `{${keysOf(part["content"])}}:${String(part["content"]["type"])}` : typeof part["content"]}`;
    }
    default: {
      return base;
    }
  }
};

/**
 * The structural shape of saved rows, free of ids, times and prose: each
 * table's columns, each message's envelope and part shapes, each turn's
 * status with the columns it fills, and each thread-name kind. Two fixtures
 * with the same shape exercise the same reader paths.
 */
export const savedStateShape = (rows: SavedStateRows): string[] => {
  const shape = new Set<string>();
  for (const table of SAVED_STATE_TABLES) {
    const tableRows = rows[table];
    if (tableRows === undefined) {
      continue;
    }
    const first = tableRows[0];
    if (first !== undefined) {
      shape.add(`${table} columns {${keysOf(first)}}`);
    }
  }
  for (const message of rows.chat_messages ?? []) {
    const content = message["content"];
    const role = message["role"];
    if (!isRecord(content)) {
      shape.add(`${String(role)} content ${typeof content}`);
      continue;
    }
    shape.add(
      `${String(role)} content {${keysOf(content)}} v${String(content["version"])} metadata {${keysOf(content["metadata"])}}`,
    );
    const turnOutcome = isRecord(content["metadata"])
      ? content["metadata"]["turnOutcome"]
      : undefined;
    if (turnOutcome !== undefined) {
      shape.add(`${String(role)} turnOutcome {${keysOf(turnOutcome)}}`);
    }
    const data = content["data"];
    for (const part of Array.isArray(data) ? data : []) {
      shape.add(partShape(role, part));
    }
  }
  for (const turn of rows.chat_turns ?? []) {
    const filled = Object.entries(turn)
      .filter(([, value]) => value !== null)
      .map(([key]) => key)
      .toSorted()
      .join(",");
    shape.add(
      `turn ${String(turn["status"])} interaction=${String(turn["interaction_type"])} {${filled}}`,
    );
  }
  for (const name of rows.chat_thread_names ?? []) {
    shape.add(`name ${String(name["kind"])} target=${keysOf(name["target"])}`);
  }
  return [...shape].toSorted();
};

// --- Loading ----------------------------------------------------------------

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * `fixture` with every uuid replaced by a fresh one and its actors replaced
 * by `actors`, so each test loads its own copy.
 */
export const rebindSavedState = (
  fixture: SavedStateFixture,
  actors: SavedStateFixture["actors"],
): SavedStateFixture => {
  const fresh = new Map<string, string>();
  const text = JSON.stringify(fixture)
    .replaceAll(fixture.actors.organizationId, () => actors.organizationId)
    .replaceAll(fixture.actors.userId, () => actors.userId)
    .replaceAll(UUID_PATTERN, (uuid) => {
      const known = fresh.get(uuid.toLowerCase());
      if (known !== undefined) {
        return known;
      }
      const next = Bun.randomUUIDv7();
      fresh.set(uuid.toLowerCase(), next);
      return next;
    });
  return { ...asTestRaw<SavedStateFixture>(JSON.parse(text)), actors };
};

/**
 * Inserts a rebound fixture's rows into the current schema, column by
 * column, then runs every chat data migration the release predates. A column
 * the current schema lacks fails the load: the fixture's data would be lost.
 */
export const loadSavedState = async (
  db: TestDatabase,
  fixture: SavedStateFixture,
): Promise<void> => {
  for (const table of SAVED_STATE_TABLES) {
    const rows = fixture.rows[table] ?? [];
    if (rows.length === 0) {
      continue;
    }
    const columns = new Set(
      (
        await db.execute<{ column_name: string }>(
          sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`,
        )
      ).rows.map(({ column_name }) => column_name),
    );
    for (const row of rows) {
      const keys = Object.keys(row);
      const dropped = keys.filter((key) => !columns.has(key));
      if (dropped.length > 0) {
        panic(
          `${table} no longer has ${dropped.join(", ")}, which ${fixture.sourceCommit} wrote`,
        );
      }
      const list = sql.join(
        keys.map((key) => sql.identifier(key)),
        sql`, `,
      );
      await db.execute(
        sql`INSERT INTO ${sql.identifier(table)} (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::${sql.identifier(table)}, ${JSON.stringify(row)}::text::jsonb)`,
      );
    }
  }
  for (const migration of CHAT_DATA_MIGRATIONS) {
    if (migration <= fixture.newestMigration) {
      continue;
    }
    for (const statement of statementsOf(migration)) {
      await db.execute(sql.raw(statement));
    }
  }
};
