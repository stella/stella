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
    "../../drizzle/20261029094325_case_law_fulltext_state/migration.sql",
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
  await rejects(
    "UPDATE case_law_decisions SET metadata='{}' WHERE id='legacy'",
    [],
  );
  await db.query(
    "UPDATE case_law_decisions SET text_state=$1 WHERE id='legacy'",
    [pending],
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

type FunctionDefinition = {
  oid: number;
  schema_name: string;
  function_name: string;
  language_name: string;
  source: string;
};

type FunctionInspection = {
  visited: string[];
  violations: string[];
};

const SQL_SPECIAL_FORMS = new Set([
  "and",
  "or",
  "not",
  "array",
  "case",
  "cast",
  "coalesce",
  "exists",
  "filter",
  "greatest",
  "if",
  "in",
  "least",
  "nullif",
  "over",
  "row",
  "values",
  "within",
]);

const AUDITED_NATIVE_FUNCTIONS = new Set([
  "clock_timestamp",
  "jsonb_build_object",
  "to_char",
]);

const inspectTriggerFunctionTree = async (
  rootSchema: string,
  rootFunction: string,
): Promise<FunctionInspection> => {
  const functionsToInspect = [{ schema: rootSchema, name: rootFunction }];
  const visitedOids = new Set<number>();
  const visited: string[] = [];
  const violations: string[] = [];

  while (functionsToInspect.length > 0) {
    const target = functionsToInspect.pop();
    if (target === undefined) {
      break;
    }
    const result = await db.query<FunctionDefinition>(
      `SELECT p.oid::integer AS oid,
              n.nspname AS schema_name,
              p.proname AS function_name,
              l.lanname AS language_name,
              p.prosrc AS source
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid = p.prolang
       WHERE n.nspname = $1 AND p.proname = $2`,
      [target.schema, target.name],
    );
    const definitions = result.rows;
    if (definitions.length === 0) {
      violations.push(`unresolved function ${target.schema}.${target.name}`);
      continue;
    }

    for (const definition of definitions) {
      if (visitedOids.has(definition.oid)) {
        continue;
      }
      visitedOids.add(definition.oid);
      const label = `${definition.schema_name}.${definition.function_name}`;
      visited.push(label);

      if (
        definition.schema_name === "pg_catalog" &&
        definition.language_name !== "sql" &&
        definition.language_name !== "plpgsql"
      ) {
        if (!AUDITED_NATIVE_FUNCTIONS.has(definition.function_name)) {
          violations.push(`unreviewed native function ${label}`);
        }
        continue;
      }
      if (
        definition.schema_name !== "public" &&
        definition.schema_name !== "pg_catalog"
      ) {
        violations.push(`unsupported function namespace ${label}`);
        continue;
      }
      if (
        definition.language_name !== "sql" &&
        definition.language_name !== "plpgsql"
      ) {
        violations.push(
          `unsupported function language ${definition.language_name} for ${label}`,
        );
        continue;
      }

      // Reject quoted/custom invocation syntax rather than leaving a path the
      // conservative call scanner cannot resolve from the catalog.
      const code = definition.source.replace(/'(?:''|[^'])*'/gu, "''");
      if (/["$]/u.test(code) || /\bOPERATOR\s*\(/iu.test(code)) {
        violations.push(`unsupported invocation syntax in ${label}`);
      }
      const body = code.replace(
        /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/giu,
        "IS DISTINCT OPERATOR",
      );
      const readsOrDynamicExecution =
        /\b(?:SELECT|FROM|JOIN|TABLE|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY|EXECUTE|PERFORM|CALL|OPEN|FETCH|LOCK|REFRESH)\b/iu.test(
          body,
        );
      if (readsOrDynamicExecution) {
        violations.push(`read or dynamic execution in ${label}`);
      }

      const callPattern =
        /(?:(?<schema>[a-z_][a-z0-9_$]*)\s*\.\s*)?(?<name>[a-z_][a-z0-9_$]*)\s*\(/giu;
      for (const match of body.matchAll(callPattern)) {
        const name = match.groups?.["name"]?.toLowerCase();
        const schema = match.groups?.["schema"]?.toLowerCase();
        if (name === undefined || SQL_SPECIAL_FORMS.has(name)) {
          continue;
        }
        if (schema !== undefined) {
          if (schema !== "public" && schema !== "pg_catalog") {
            violations.push(
              `unsupported callee ${schema}.${name} from ${label}`,
            );
            continue;
          }
          functionsToInspect.push({ schema, name });
          continue;
        }

        // With unknown argument types, inspect every same-named candidate in
        // the allowed search path instead of guessing which overload resolves.
        let foundCandidate = false;
        for (const candidateSchema of ["pg_catalog", "public"]) {
          const candidate = await db.query<{ oid: number }>(
            `SELECT p.oid::integer AS oid
             FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = $1 AND p.proname = $2`,
            [candidateSchema, name],
          );
          if (candidate.rows.length > 0) {
            foundCandidate = true;
            functionsToInspect.push({ schema: candidateSchema, name });
          }
        }
        if (!foundCandidate) {
          violations.push(`unresolved callee ${name} from ${label}`);
        }
      }
    }
  }

  return { visited, violations };
};

test("full-text state trigger and every called helper avoid table reads", async () => {
  const inspection = await inspectTriggerFunctionTree(
    "public",
    "case_law_decision_text_state_guard",
  );

  expect(inspection.visited).toContain(
    "public.case_law_decision_text_state_guard",
  );
  expect(inspection.visited.length).toBeGreaterThan(0);
  expect(inspection.violations).toEqual([]);
});

test("function inspection rejects reads in a nested public helper", async () => {
  await db.exec(`
    CREATE FUNCTION public.fulltext_guard_probe_root() RETURNS text
    LANGUAGE plpgsql AS $probe$
    DECLARE result text;
    BEGIN
      result := public.fulltext_guard_probe_nested();
      RETURN result;
    END
    $probe$;
    CREATE FUNCTION public.fulltext_guard_probe_nested() RETURNS text
    LANGUAGE sql AS $probe$
      SELECT decision.id
      FROM public.case_law_decisions decision
      LIMIT 1
    $probe$;
  `);

  const inspection = await inspectTriggerFunctionTree(
    "public",
    "fulltext_guard_probe_root",
  );

  expect(inspection.visited).toContain("public.fulltext_guard_probe_nested");
  expect(inspection.violations).toContain(
    "read or dynamic execution in public.fulltext_guard_probe_nested",
  );
});

test("redacted inserts require explicit NULL under the declarative row constraint", async () => {
  expect(
    await rejectionOf(
      db.query(
        "INSERT INTO case_law_decisions (id,redacted_at) VALUES ('redacted-default',now())",
      ),
    ),
  ).toMatchObject({
    code: "23514",
    constraint: "case_law_decisions_text_state_valid",
  });
  await db.query(
    "INSERT INTO case_law_decisions (id,redacted_at,text_state) VALUES ('redacted-explicit',now(),NULL)",
  );
  expect(await stateOf("redacted-explicit")).toBeNull();
  await rejects(
    "UPDATE case_law_decisions SET text_state=$1 WHERE id='redacted-explicit'",
    [pending],
  );
});

test("row validity is a deferred CHECK and INSERT default uses only stable row-free expressions", async () => {
  const constraints = await db.query<{
    convalidated: boolean;
    contype: string;
  }>(
    "SELECT convalidated,contype FROM pg_constraint WHERE conrelid='public.case_law_decisions'::regclass AND conname='case_law_decisions_text_state_valid'",
  );
  expect(constraints.rows).toEqual([{ convalidated: false, contype: "c" }]);
  const defaults = await db.query<{ expression: string }>(
    "SELECT pg_get_expr(adbin,adrelid) AS expression FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE a.attrelid='public.case_law_decisions'::regclass AND a.attname='text_state'",
  );
  expect(defaults.rows.at(0)?.expression).toContain("CURRENT_TIMESTAMP");
  expect(defaults.rows.at(0)?.expression).not.toMatch(
    /clock_timestamp|\b(?:SELECT|FROM|JOIN)\b/iu,
  );
  const functions = await db.query<{ proname: string; provolatile: string }>(
    "SELECT proname,provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pg_catalog' AND proname IN ('jsonb_build_object','to_char','timezone')",
  );
  expect(functions.rows.length).toBeGreaterThan(0);
  for (const fn of functions.rows) {
    expect(fn.provolatile).not.toBe("v");
  }
});
