import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { currentFolioBlockId } from "@stll/folio-core";

/**
 * The stored block-id rewrite, applied to rows written before the deploy that
 * brought paragraph ids into range.
 *
 * The migration re-implements folio's mapping in SQL, so the one thing this
 * suite must prove is that the two agree: every rewritten id is compared with
 * `currentFolioBlockId` from the package rather than with a literal. The shared
 * test database boots the current schema with no such rows, so the suite builds
 * the columns the migration touches and runs the migration file itself.
 */
const MIGRATION_FILE = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260907170000_folio_block_ids_in_range/migration.sql",
);

/** Out of range: the first hex digit is 8-F. */
const RECORDED = "FFFF0001";
const RECORDED_LOWER = "8abcdef0";
const RECORDED_OTHER = "80000000";
/** In range, sequential, blank and office ids never move. */
const IN_RANGE = "7FFF0001";

const PRE_MIGRATION_SCHEMA = `
CREATE TABLE docx_suggestions (id text PRIMARY KEY, op_payload jsonb NOT NULL);
CREATE TABLE document_review_reference_passages (id text PRIMARY KEY, block_id varchar(128) NOT NULL);
CREATE TABLE justifications (id text PRIMARY KEY, content jsonb NOT NULL);
CREATE TABLE chat_messages (id text PRIMARY KEY, content jsonb NOT NULL);
`;

const PRE_MIGRATION_ROWS = `
INSERT INTO docx_suggestions VALUES
  ('op_block', '{"id": "op-1", "type": "replaceInBlock", "blockId": "${RECORDED}", "find": "a", "replace": "b"}'::jsonb),
  ('op_range', '{"id": "op-2", "type": "replaceRange", "replace": "b",
     "range": {"type": "textRange", "story": "main", "blockId": "${RECORDED_LOWER}", "startOffset": 0, "endOffset": 1, "selectedTextHash": "h"}}'::jsonb),
  ('op_section', '{"id": "op-3", "type": "replaceSection", "headingBlockId": "${RECORDED}", "endBlockId": "${RECORDED_OTHER}", "blockId": "seq-0004"}'::jsonb),
  ('op_untouched', '{"id": "op-4", "type": "replaceInBlock", "blockId": "${IN_RANGE}", "find": "${RECORDED}", "replace": "b"}'::jsonb);
INSERT INTO document_review_reference_passages VALUES
  ('passage_moved', '${RECORDED}'),
  ('passage_sequential', 'seq-0011'),
  ('passage_in_range', '${IN_RANGE}');
INSERT INTO justifications VALUES
  ('justification_moved', '{"blocks": [
     {"kind": "docx-folio", "citations": [
       {"citationStatus": "verified", "blockId": "${RECORDED}", "text": "quoted"},
       {"citationStatus": "unverified", "text": "no block"}]},
     {"kind": "pdf-bates", "pages": [1]}]}'::jsonb),
  ('justification_untouched', '{"blocks": [{"kind": "docx-folio", "citations": [{"citationStatus": "verified", "blockId": "${IN_RANGE}", "text": "q"}]}]}'::jsonb);
INSERT INTO chat_messages VALUES
  ('msg_cited', '{"version": 3, "metadata": {"turnOutcome": "complete"}, "data": [
     {"type": "text", "text": "See [clause 2](#folio:${RECORDED}) and [clause 3](#folio:${RECORDED_LOWER}), again [2](#folio:${RECORDED}) but not [x](#office:pptx-0123456789abcdef)."}]}'::jsonb),
  ('msg_untouched', '{"version": 3, "data": [{"type": "text", "text": "See [clause](#folio:${IN_RANGE}) and #folio:${RECORDED}0 is not an id"}]}'::jsonb);
`;

let database: PGlite;

const migrationStatements = (): string[] =>
  readFileSync(MIGRATION_FILE, "utf-8")
    .split("--> statement-breakpoint")
    .filter((statement) => statement.trim().length > 0);

const applyMigration = async (): Promise<void> => {
  for (const statement of migrationStatements()) {
    // Sequential on purpose: the functions precede the rewrites that use them.
    await database.exec(statement);
  }
};

const jsonOf = async (
  table: string,
  column: string,
  id: string,
): Promise<Record<string, unknown>> => {
  const result = await database.query<{ value: Record<string, unknown> }>(
    `SELECT ${column} AS value FROM ${table} WHERE id = $1`,
    [id],
  );
  const value = result.rows.at(0)?.value;
  if (value === undefined) {
    throw new Error(`no ${table} row ${id}`);
  }
  return value;
};

const blockIdOf = async (id: string): Promise<string> => {
  const result = await database.query<{ block_id: string }>(
    "SELECT block_id FROM document_review_reference_passages WHERE id = $1",
    [id],
  );
  const value = result.rows.at(0)?.block_id;
  if (value === undefined) {
    throw new Error(`no passage row ${id}`);
  }
  return value;
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

test("the SQL mapping is the package's mapping", () => {
  // Sanity for the fixtures themselves: every recorded id really moves.
  for (const recorded of [RECORDED, RECORDED_LOWER, RECORDED_OTHER]) {
    expect(currentFolioBlockId(recorded)).not.toBe(recorded);
  }
  expect(currentFolioBlockId(IN_RANGE)).toBe(IN_RANGE);
});

test("every block-id field of a suggestion operation moves, nested ones included", async () => {
  expect(await jsonOf("docx_suggestions", "op_payload", "op_block")).toEqual({
    id: "op-1",
    type: "replaceInBlock",
    blockId: currentFolioBlockId(RECORDED),
    find: "a",
    replace: "b",
  });
  expect(
    await jsonOf("docx_suggestions", "op_payload", "op_range"),
  ).toMatchObject({
    range: {
      blockId: currentFolioBlockId(RECORDED_LOWER),
      startOffset: 0,
      endOffset: 1,
    },
  });
  expect(await jsonOf("docx_suggestions", "op_payload", "op_section")).toEqual({
    id: "op-3",
    type: "replaceSection",
    headingBlockId: currentFolioBlockId(RECORDED),
    endBlockId: currentFolioBlockId(RECORDED_OTHER),
    blockId: "seq-0004",
  });
});

test("an in-range id and an id-shaped value outside a block-id field stay", async () => {
  expect(
    await jsonOf("docx_suggestions", "op_payload", "op_untouched"),
  ).toEqual({
    id: "op-4",
    type: "replaceInBlock",
    blockId: IN_RANGE,
    find: RECORDED,
    replace: "b",
  });
});

test("a reference passage's block moves; sequential and in-range ids stay", async () => {
  expect(await blockIdOf("passage_moved")).toBe(currentFolioBlockId(RECORDED));
  expect(await blockIdOf("passage_sequential")).toBe("seq-0011");
  expect(await blockIdOf("passage_in_range")).toBe(IN_RANGE);
});

test("a justification's verified citations move and the rest of the content is kept", async () => {
  expect(
    await jsonOf("justifications", "content", "justification_moved"),
  ).toEqual({
    blocks: [
      {
        kind: "docx-folio",
        citations: [
          {
            citationStatus: "verified",
            blockId: currentFolioBlockId(RECORDED),
            text: "quoted",
          },
          { citationStatus: "unverified", text: "no block" },
        ],
      },
      { kind: "pdf-bates", pages: [1] },
    ],
  });
  expect(
    await jsonOf("justifications", "content", "justification_untouched"),
  ).toEqual({
    blocks: [
      {
        kind: "docx-folio",
        citations: [
          { citationStatus: "verified", blockId: IN_RANGE, text: "q" },
        ],
      },
    ],
  });
});

test("citation links in a chat message move, office links and prose do not", async () => {
  const moved = currentFolioBlockId(RECORDED);
  const movedLower = currentFolioBlockId(RECORDED_LOWER);
  expect(await jsonOf("chat_messages", "content", "msg_cited")).toEqual({
    version: 3,
    metadata: { turnOutcome: "complete" },
    data: [
      {
        type: "text",
        text: `See [clause 2](#folio:${moved}) and [clause 3](#folio:${movedLower}), again [2](#folio:${moved}) but not [x](#office:pptx-0123456789abcdef).`,
      },
    ],
  });
  expect(await jsonOf("chat_messages", "content", "msg_untouched")).toEqual({
    version: 3,
    data: [
      {
        type: "text",
        text: `See [clause](#folio:${IN_RANGE}) and #folio:${RECORDED}0 is not an id`,
      },
    ],
  });
});

test("a second run changes nothing", async () => {
  const before = await jsonOf("chat_messages", "content", "msg_cited");
  await applyMigration();
  expect(await jsonOf("chat_messages", "content", "msg_cited")).toEqual(before);
  expect(await blockIdOf("passage_moved")).toBe(currentFolioBlockId(RECORDED));
});
