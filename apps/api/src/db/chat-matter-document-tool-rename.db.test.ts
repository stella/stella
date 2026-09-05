import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * The stored chat tool-name rewrite, applied to rows written before the deploy.
 *
 * `create_workspace_document` became `create_matter_document` with no alias, so
 * `validateMessage` rejects the old name outright ("Unknown chat tool"). A
 * thread persisted mid-approval would reload into a 400 forever without this
 * migration, and the shared test database boots the CURRENT schema with no such
 * rows — so this suite builds the one column the migration touches and runs the
 * migration file itself.
 */
const MIGRATION_FILE = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260905210000_chat_matter_document_tool_rename/migration.sql",
);

const PRE_MIGRATION_SCHEMA = `
CREATE TABLE chat_messages (
  id text PRIMARY KEY,
  content jsonb NOT NULL
);
`;

/**
 * One row per shape the rewrite has to get right: a live approval, settled
 * history, a v1 payload, a part order that must survive, a message with no tool
 * call at all, and a `data` that is not an array (defensive: v1 content is typed
 * `unknown[]` but nothing enforces it in the column).
 */
const PRE_MIGRATION_ROWS = `
INSERT INTO chat_messages VALUES
  ('msg_pending', '{
     "version": 3,
     "metadata": {"turnOutcome": "pending"},
     "data": [
       {"type": "tool-call", "name": "create_workspace_document", "id": "call_1",
        "state": "approval-requested", "input": {"status": "raw", "rawArguments": "{}"},
        "approval": {"id": "ap_1", "needsApproval": true}}
     ]
   }'::jsonb),
  ('msg_history', '{
     "version": 2,
     "data": [
       {"type": "text", "text": "first"},
       {"type": "tool-call", "name": "create_workspace_document", "id": "call_2",
        "state": "complete", "input": {"status": "raw", "rawArguments": "{}"}},
       {"type": "tool-call", "name": "create_document", "id": "call_3",
        "state": "complete", "input": {"status": "raw", "rawArguments": "{}"}},
       {"type": "text", "text": "last"}
     ]
   }'::jsonb),
  ('msg_v1', '{
     "version": 1,
     "data": [
       {"type": "tool-call", "name": "create_workspace_document", "id": "call_4",
        "state": "complete"}
     ]
   }'::jsonb),
  ('msg_untouched', '{
     "version": 3,
     "data": [{"type": "text", "text": "no tool calls here"}]
   }'::jsonb),
  ('msg_not_an_array', '{"version": 3, "data": {"broken": true}}'::jsonb);
`;

let database: PGlite;

const migrationStatements = (): string[] =>
  readFileSync(MIGRATION_FILE, "utf-8")
    .split("--> statement-breakpoint")
    .filter((statement) => statement.trim().length > 0);

const applyMigration = async (): Promise<void> => {
  for (const statement of migrationStatements()) {
    // Sequential on purpose: the timeout settings precede the rewrite.
    await database.exec(statement);
  }
};

const contentOf = async (id: string): Promise<Record<string, unknown>> => {
  const result = await database.query<{ content: Record<string, unknown> }>(
    "SELECT content FROM chat_messages WHERE id = $1",
    [id],
  );
  const content = result.rows.at(0)?.content;
  if (content === undefined) {
    throw new Error(`no chat_messages row ${id}`);
  }
  return content;
};

const partsOf = async (id: string): Promise<Record<string, unknown>[]> => {
  const { data } = await contentOf(id);
  if (!Array.isArray(data)) {
    throw new TypeError(`chat_messages row ${id} has no data array`);
  }
  return data;
};

beforeAll(async () => {
  database = new PGlite();
  await database.exec(PRE_MIGRATION_SCHEMA);
  await database.exec(PRE_MIGRATION_ROWS);
  await applyMigration();
}, 60_000);

afterAll(async () => {
  await database.close();
});

test("a pending approval keeps every field and only its tool name moves", async () => {
  const [part] = await partsOf("msg_pending");
  expect(part).toEqual({
    approval: { id: "ap_1", needsApproval: true },
    id: "call_1",
    input: { rawArguments: "{}", status: "raw" },
    name: "create_matter_document",
    state: "approval-requested",
    type: "tool-call",
  });
  // `jsonb_set` on `{data}` must not disturb the sibling keys.
  expect(await contentOf("msg_pending")).toMatchObject({
    metadata: { turnOutcome: "pending" },
    version: 3,
  });
});

test("settled history is rewritten too, in order, leaving other tools alone", async () => {
  expect(
    (await partsOf("msg_history")).map((part) => part["name"] ?? part["text"]),
  ).toEqual(["first", "create_matter_document", "create_document", "last"]);
});

test("a v1 payload is rewritten: every version keeps its parts under data", async () => {
  expect((await partsOf("msg_v1")).at(0)).toMatchObject({
    name: "create_matter_document",
  });
});

test("a message with no matching tool call is left byte-for-byte alone", async () => {
  expect(await contentOf("msg_untouched")).toEqual({
    data: [{ text: "no tool calls here", type: "text" }],
    version: 3,
  });
  expect(await contentOf("msg_not_an_array")).toEqual({
    data: { broken: true },
    version: 3,
  });
});

test("re-running the migration is a no-op", async () => {
  const before = await contentOf("msg_history");
  await applyMigration();
  expect(await contentOf("msg_history")).toEqual(before);
});
