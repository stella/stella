import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { decisionTextStateSchema } from "@stll/api-contract/case-law-fulltext-state";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createSchemaPglite } from "../tests/pglite-schema";
import { CASE_LAW_TEXT_STATE_INDEXES } from "./case-law-fulltext-state";

const db = await createSchemaPglite();
const hash = "a".repeat(64);
const instant = "2026-10-28T12:00:00.000Z";
const verifyStorage = { type: "verify_storage" };
const listing = { type: "publisher_listing", slice: "2014", page: 9 };
const pending = {
  recovery: verifyStorage,
  status: "fetch_pending",
  attemptCount: 0,
  nextAttemptAt: instant,
  lastAttemptAt: null,
};
const stored = {
  status: "stored",
  storage: "postgres",
  contentHash: hash,
  verifiedAt: instant,
};
const corpus = { ...stored, storage: "corpus" };
const migration = readFileSync(
  new URL(
    "../../drizzle/20261028160000_case_law_fulltext_state/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

beforeAll(async () => {
  await db.exec(`CREATE ROLE stella_public_law_reader;
    CREATE TABLE public.case_law_decisions (
      id text PRIMARY KEY, source_id text, fulltext text, sections jsonb, document_ast jsonb,
      content_hash text,
      text_s3_key text,
      normalized_s3_key text,
      ast_s3_key text,
      metadata jsonb,
      redacted_at timestamptz,
      source_hash text,
      source_raw_s3_key text);
    INSERT INTO public.case_law_decisions (id) VALUES ('legacy'); BEGIN;`);
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) {
      await db.exec(statement);
    }
  }
  await db.exec("COMMIT");
});
afterAll(async () => await db.close());
const stateOf = async (id: string) =>
  (
    await db.query<{ text_state: unknown }>(
      "SELECT text_state FROM public.case_law_decisions WHERE id=$1",
      [id],
    )
  ).rows.at(0)?.text_state;
const rejects = async (query: string, values: unknown[]) => {
  expect(await rejectionOf(db.query(query, values))).toMatchObject({
    code: "23514",
  });
};

test("legacy adoption and replay are honest and stable", async () => {
  expect(await stateOf("legacy")).toBeNull();
  await db.query(
    "UPDATE case_law_decisions SET metadata='{}' WHERE id='legacy'",
  );
  expect(await stateOf("legacy")).toMatchObject({
    status: "fetch_pending",
    attemptCount: 0,
    lastAttemptAt: null,
    recovery: verifyStorage,
  });
  await db.query("INSERT INTO case_law_decisions (id) VALUES ('new')");
  const initial = await stateOf("new");
  expect(v.safeParse(decisionTextStateSchema, initial).success).toBe(true);
  await db.query("UPDATE case_law_decisions SET metadata='{}' WHERE id='new'");
  expect(await stateOf("new")).toEqual(initial);
});

test("every protected payload field invalidates inherited proof", async () => {
  const changes = [
    ["fulltext", "replacement"],
    ["sections", JSON.stringify([{ text: "replacement" }])],
    [
      "document_ast",
      JSON.stringify({
        blocks: [{ type: "paragraph", plainText: "replacement" }],
      }),
    ],
    ["content_hash", "b".repeat(64)],
    ["text_s3_key", "new-text"],
    ["normalized_s3_key", "new-sections"],
    ["ast_s3_key", "new-ast"],
  ] as const;
  for (const [column, value] of changes) {
    const id = `mutation-${column}`;
    await db.query(
      "INSERT INTO case_law_decisions (id,fulltext,text_state) VALUES ($1,'original',$2)",
      [id, stored],
    );
    await db.query("UPDATE case_law_decisions SET metadata='{}' WHERE id=$1", [
      id,
    ]);
    expect(await stateOf(id)).toEqual(stored);
    // Identifiers come only from the fixed protected column list above.
    await db.query(`UPDATE case_law_decisions SET ${column}=$1 WHERE id=$2`, [
      value,
      id,
    ]);
    expect(await stateOf(id)).toMatchObject({
      status: "fetch_pending",
      attemptCount: 0,
    });
  }
});

test("corpus trim preserves only matching proof", async () => {
  await db.query(
    `INSERT INTO case_law_decisions
    (id,fulltext,sections,document_ast,content_hash,text_s3_key,normalized_s3_key,ast_s3_key,text_state)
    VALUES ('trim','text','[]','{}',$1,'text','sections','ast',$2)`,
    [hash, corpus],
  );
  await db.query(
    "UPDATE case_law_decisions SET fulltext=NULL, sections=NULL, document_ast=NULL WHERE id='trim'",
  );
  expect(await stateOf("trim")).toEqual(corpus);
  await rejects(
    "INSERT INTO case_law_decisions (id,content_hash,text_s3_key,normalized_s3_key,ast_s3_key,text_state) VALUES ('bad-hash',$1,'t','s','a',$2)",
    ["b".repeat(64), corpus],
  );
  await rejects(
    "INSERT INTO case_law_decisions (id,content_hash,text_state) VALUES ('no-keys',$1,$2)",
    [hash, corpus],
  );
  await db.query(
    "UPDATE case_law_decisions SET content_hash=$1 WHERE id='trim'",
    ["b".repeat(64)],
  );
  expect(await stateOf("trim")).toMatchObject({ status: "fetch_pending" });
});

test("replacement publisher observations invalidate inherited recovery and absence evidence", async () => {
  const absence = {
    status: "publisher_has_no_text",
    observedAt: instant,
    evidence: {
      recordUrl: "https://example.test/decision",
      sourceHash: hash,
      field: "document",
      kind: "no_document_attachment",
    },
  };
  for (const [index, state] of [
    absence,
    { ...pending, recovery: listing },
  ].entries()) {
    const id = `source-replacement-${index}`;
    await db.query(
      "INSERT INTO case_law_decisions (id,source_hash,source_raw_s3_key,text_state) VALUES ($1,$2,'old-raw',$3)",
      [id, hash, state],
    );
    await db.query(
      "UPDATE case_law_decisions SET source_hash=$1,source_raw_s3_key='new-raw' WHERE id=$2",
      ["b".repeat(64), id],
    );
    expect(await stateOf(id)).toMatchObject({
      status: "fetch_pending",
      attemptCount: 0,
      recovery: verifyStorage,
    });
  }
});

test("postgres proof needs text; erasure clears proof and restoration becomes pending", async () => {
  for (const [id, ast] of [
    ["empty", { blocks: [] }],
    ["image", { blocks: [{ type: "image", alt: "caption" }] }],
    ["numeric", { blocks: [{ type: "paragraph", plainText: 123 }] }],
  ]) {
    await rejects(
      "INSERT INTO case_law_decisions (id,fulltext,sections,document_ast,text_state) VALUES ($1,'  ','[]',$2,$3)",
      [id, ast, stored],
    );
  }
  await db.query(
    "INSERT INTO case_law_decisions (id,document_ast,text_state) VALUES ('ast',$1,$2)",
    [
      {
        blocks: [
          { type: "paragraph", content: [{ type: "text", text: "Visible" }] },
        ],
      },
      stored,
    ],
  );
  await db.query(
    "UPDATE case_law_decisions SET redacted_at=now() WHERE id='ast'",
  );
  expect(await stateOf("ast")).toBeNull();
  await db.query(
    "UPDATE case_law_decisions SET redacted_at=NULL WHERE id='ast'",
  );
  expect(await stateOf("ast")).toMatchObject({ status: "fetch_pending" });
});

test("database shape validation follows the shared strict contract", async () => {
  const valid = [
    stored,
    pending,
    { ...pending, recovery: listing },
    { ...pending, recovery: { type: "stored_raw_retry" } },
    corpus,
    {
      status: "publisher_has_no_text",
      observedAt: instant,
      evidence: {
        recordUrl: "https://example.test/decision",
        sourceHash: hash,
        field: "document",
        kind: "no_document_attachment",
      },
    },
    {
      status: "metadata_only_by_source",
      observedAt: instant,
      policy: "listing",
    },
    ...[
      { kind: "http", status: 404 },
      { kind: "parser_refusal", code: "empty" },
      { kind: "size", limitBytes: 1 },
      { kind: "timeout", timeoutMs: 1 },
      { kind: "network", code: "reset" },
      { kind: "storage", code: "read" },
    ].map((cause) => ({
      recovery: verifyStorage,
      status: "fetch_failed",
      attemptCount: 1,
      lastAttemptAt: instant,
      nextAttemptAt: instant,
      cause,
    })),
  ];
  const invalid = [
    null,
    {},
    { ...pending, extra: true },
    { ...pending, recovery: null },
    { ...pending, recovery: { type: "verify_storage", page: 0 } },
    { ...pending, recovery: { type: "stored_raw_retry", page: 0 } },
    { ...pending, recovery: { ...listing, page: -1 } },
    { ...pending, recovery: { ...listing, page: 0.5 } },
    { ...pending, recovery: { ...listing, slice: "" } },
    { ...pending, recovery: { ...listing, slice: "x".repeat(129) } },
    { ...pending, recovery: { type: "publisher_listing", slice: "2014" } },
    { ...pending, attemptCount: -1 },
    { ...pending, nextAttemptAt: "2026-10-28T12:00:00Z" },
    { ...stored, contentHash: "x" },
    { ...stored, storage: "unknown" },
    { ...stored, verifiedAt: "2026-02-30T12:00:00.000Z" },
    {
      recovery: verifyStorage,
      status: "fetch_failed",
      attemptCount: 1,
      lastAttemptAt: instant,
      nextAttemptAt: instant,
      cause: { kind: "http", status: 700 },
    },
  ];
  for (const value of [...valid, ...invalid]) {
    const result = await db.query<{ valid: boolean }>(
      "SELECT public.case_law_decision_text_state_shape_valid($1::text::jsonb) AS valid",
      [JSON.stringify(value)],
    );
    expect(result.rows.at(0)?.valid).toBe(
      v.safeParse(decisionTextStateSchema, value).success,
    );
  }
  await rejects(
    "INSERT INTO case_law_decisions (id,text_state) VALUES ('malformed',$1)",
    [{ ...pending, extra: true }],
  );
});

test("listing checkpoint survives retry state transitions and unrelated writes", async () => {
  const checkpoint = { ...pending, recovery: listing };
  await db.query(
    "INSERT INTO case_law_decisions (id,text_state) VALUES ('checkpoint',$1)",
    [checkpoint],
  );
  const failed = {
    status: "fetch_failed",
    attemptCount: 1,
    lastAttemptAt: instant,
    nextAttemptAt: instant,
    recovery: listing,
    cause: { kind: "network", code: "reset" },
  };
  await db.query(
    "UPDATE case_law_decisions SET text_state=$1 WHERE id='checkpoint'",
    [failed],
  );
  await db.query(
    "UPDATE case_law_decisions SET metadata='{}' WHERE id='checkpoint'",
  );
  expect(await stateOf("checkpoint")).toEqual(failed);
  const resumed = { ...checkpoint, attemptCount: 2, lastAttemptAt: instant };
  await db.query(
    "UPDATE case_law_decisions SET text_state=$1 WHERE id='checkpoint'",
    [resumed],
  );
  expect(await stateOf("checkpoint")).toEqual(resumed);
  await db.query(
    "UPDATE case_law_decisions SET fulltext='new revision' WHERE id='checkpoint'",
  );
  expect(await stateOf("checkpoint")).toMatchObject({
    status: "fetch_pending",
    recovery: verifyStorage,
  });
});

test("unfinished raw replay stays durable across failure even when postgres text is readable", async () => {
  const recovery = { type: "stored_raw_retry" };
  const state = { ...pending, recovery };
  await db.query(
    "INSERT INTO case_law_decisions (id,fulltext,text_state) VALUES ('raw-retry','already readable',$1)",
    [state],
  );
  expect(await stateOf("raw-retry")).toEqual(state);
  const failed = {
    status: "fetch_failed",
    attemptCount: 1,
    lastAttemptAt: instant,
    nextAttemptAt: instant,
    recovery,
    cause: { kind: "storage", code: "settlement_pending" },
  };
  await db.query(
    "UPDATE case_law_decisions SET text_state=$1 WHERE id='raw-retry'",
    [failed],
  );
  expect(await stateOf("raw-retry")).toEqual(failed);
  await db.query(
    "UPDATE case_law_decisions SET text_state=$1 WHERE id='raw-retry'",
    [state],
  );
  expect(await stateOf("raw-retry")).toEqual(state);
});

test("online index declarations match PostgreSQL catalog definitions", async () => {
  for (const index of CASE_LAW_TEXT_STATE_INDEXES) {
    await db.exec(index.createSql.replace("INDEX CONCURRENTLY", "INDEX"));
    const result = await db.query<{ definition: string }>(
      "SELECT pg_get_indexdef(oid) AS definition FROM pg_class WHERE relname=$1",
      [index.name],
    );
    expect(result.rows.at(0)?.definition).toBe(
      `CREATE INDEX ${index.name} ${index.definitionBody}`,
    );
  }
});
