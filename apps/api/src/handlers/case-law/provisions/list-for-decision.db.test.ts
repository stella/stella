import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { publicLawDatabaseRolePermissionsSql } from "@/api/lib/public-law-read-db";
import {
  PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
  publicLawColumnPairs,
} from "@/api/lib/public-law-relations";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const SOURCE_ID = createSafeId<"caseLawSource">();
const PROJECTION_DIGEST = "a".repeat(64);
const ROWS_DIGEST = "b".repeat(64);
const CONTENT_HASH = "c".repeat(64);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let reader: CaseLawPublicReadDb;

const run = async (statement: SQL) => {
  await db.execute(statement);
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  reader = asTestRaw<CaseLawPublicReadDb>(
    async <T>(read: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
      await withPublicLawReaderRole(
        db,
        async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
      ),
  );

  await run(sql`INSERT INTO case_law_sources (id, adapter_key, name)
    VALUES (${SOURCE_ID}, 'provision-read-status', 'Test source')`);
  await run(sql`INSERT INTO case_law_provision_extraction_scopes
    (country, language, status, generation)
    VALUES ('CZE', 'cs', 'active', 1), ('CZE', 'sk', 'retired', 1)`);
  await run(sql`INSERT INTO case_law_provision_extraction_revisions_registry
    (revision, jurisdiction, engine_input_digest, profile_digest, projection_revision)
    VALUES
      (1, 'CZE', ${"1".repeat(64)}, ${"2".repeat(64)}, 1),
      (2, 'CZE', ${"3".repeat(64)}, ${"4".repeat(64)}, 1),
      (1, 'SVK', ${"5".repeat(64)}, ${"6".repeat(64)}, 1)`);
  await run(sql`INSERT INTO case_law_provision_extraction_revisions
    (jurisdiction, desired_revision, min_current_revision)
    VALUES ('CZE', 2, 1)`);
  await setStatusGrants("grant");
}, 120_000);

afterAll(async () => await client.close());

type DecisionOptions = {
  contentHash?: string | null;
  language?: string;
  redacted?: boolean;
};

const decision = async ({
  contentHash = CONTENT_HASH,
  language = "cs",
  redacted = false,
}: DecisionOptions = {}): Promise<SafeId<"caseLawDecision">> => {
  const id = createSafeId<"caseLawDecision">();
  await run(sql`INSERT INTO case_law_decisions
    (id, source_id, country, language, court, case_number, content_hash, redacted_at)
    VALUES (${id}, ${SOURCE_ID}, 'CZE', ${language}, 'Court', ${id},
      ${redacted ? null : contentHash},
      ${redacted ? "2026-01-01T00:00:00Z" : null}::timestamptz)`);
  return id;
};

const setState = async (id: SafeId<"caseLawDecision">, assignments: SQL) =>
  await run(sql`UPDATE case_law_provision_extractions
    SET ${assignments} WHERE decision_id = ${id}`);

type ExtractedOptions = {
  id: SafeId<"caseLawDecision">;
  outcome: "extracted_zero" | "extracted_with_rows";
  revision?: number;
  jurisdiction?: string;
};

const extracted = async ({
  id,
  outcome,
  revision = 2,
  jurisdiction = "CZE",
}: ExtractedOptions) =>
  await setState(
    id,
    sql`generation = generation + 1, outcome = ${outcome},
      row_count = ${outcome === "extracted_zero" ? 0 : 1},
      rows_digest = ${ROWS_DIGEST},
      published_projection_digest = decode(${PROJECTION_DIGEST}, 'hex'),
      published_revision = ${revision}, published_jurisdiction = ${jurisdiction},
      published_input_digest = desired_input_digest,
      published_at = now(), due_at = NULL`,
  );

type CitationOptions = {
  decisionId: SafeId<"caseLawDecision">;
  spanStart: number;
  anchor: string;
  printedWorkIdentifier?: string | null;
};

const citation = async ({
  decisionId,
  spanStart,
  anchor,
  printedWorkIdentifier = null,
}: CitationOptions) =>
  await run(sql`INSERT INTO case_law_provision_citations
    (id, decision_id, jurisdiction, work_identifier, work_number, work_year,
     work_collection, unit, section, anchor, span_start, span_end, sentence_text,
     confidence, selection, printed_work_identifier)
    VALUES (${createSafeId<"caseLawProvisionCitation">()}, ${decisionId}, 'CZE',
      '89/2012 Sb.', 89, 2012, 'Sb.', 'section', 1, ${anchor},
      ${spanStart}, ${spanStart + 5}, ${`citation ${String(spanStart)}`}, 1,
      ${printedWorkIdentifier === null ? null : "misprint-correction"},
      ${printedWorkIdentifier})`);

const withSubject = async <T>(
  id: SafeId<"caseLawDecision">,
  read: (subject: RedistributableDecisionSubject) => Promise<T>,
): Promise<T> =>
  (await withRedistributableSubject(reader, { kind: "id", id }, read)) ??
  panic("expected a public decision subject");

const page = async (id: SafeId<"caseLawDecision">, cursor?: string) =>
  await withSubject(
    id,
    async (subject) =>
      await listDecisionProvisionsHandler({
        subject,
        query: { limit: 2, ...(cursor === undefined ? {} : { cursor }) },
      }),
  );

const setStatusGrants = async (mode: "grant" | "revoke") => {
  const columnsByRelation = new Map<string, string[]>();
  for (const { relation, column } of publicLawColumnPairs(
    PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
  )) {
    const columns = columnsByRelation.get(relation) ?? [];
    columns.push(column);
    columnsByRelation.set(relation, columns);
  }
  for (const [relation, columns] of columnsByRelation) {
    const selection = sql.join(
      columns.map((column) => sql.identifier(column)),
      sql`, `,
    );
    if (mode === "grant") {
      await run(sql`GRANT SELECT (${selection}) ON TABLE ${sql.identifier(relation)}
        TO stella_public_law_reader`);
    } else {
      await run(sql`REVOKE SELECT (${selection}) ON TABLE ${sql.identifier(relation)}
        FROM stella_public_law_reader`);
    }
  }
  if (mode === "grant") {
    await run(
      sql.raw(`GRANT EXECUTE ON FUNCTION
      case_law_provision_extraction_in_scope(varchar, varchar),
      case_law_provision_extraction_input_digest(text, date, text, text, boolean)
      TO stella_public_law_reader`),
    );
  } else {
    await run(
      sql.raw(`REVOKE EXECUTE ON FUNCTION
      case_law_provision_extraction_in_scope(varchar, varchar),
      case_law_provision_extraction_input_digest(text, date, text, text, boolean)
      FROM stella_public_law_reader`),
    );
  }
};

test("pre-grant reader serves legacy links and picks up status grants without a restart", async () => {
  const id = await decision();
  await extracted({ id, outcome: "extracted_with_rows" });
  await citation({
    decisionId: id,
    spanStart: 10,
    anchor: "a",
    printedWorkIdentifier: "98/2012 Sb.",
  });
  await citation({ decisionId: id, spanStart: 20, anchor: "b" });
  await citation({ decisionId: id, spanStart: 30, anchor: "c" });
  await setStatusGrants("revoke");
  try {
    const attestation = await withPublicLawReaderRole(
      db,
      async (tx) => await tx.execute(publicLawDatabaseRolePermissionsSql()),
    );
    expect(attestation.rows.at(0)).toMatchObject({
      canReadPublicLaw: true,
      canDelegatePublicLaw: false,
    });
    const fallback = await page(id);
    expect(fallback).toMatchObject({
      items: [
        {
          spanStart: 10,
          anchor: "a",
          versionBasis: { type: "inferred", kind: "decision_date" },
          spanRole: null,
          selection: null,
          printedWorkIdentifier: null,
          targetDocumentId: null,
          targetStatus: null,
        },
        { spanStart: 20 },
      ],
      status: { type: "pending" },
      generation: "0",
      publishedProjectionDigest: null,
    });
    if (!("items" in fallback) || fallback.nextCursor === null) {
      panic("expected a pre-grant cursor page");
    }
    await setStatusGrants("grant");
    expect(await page(id, fallback.nextCursor)).toMatchObject({
      code: 409,
      response: { type: "conflict" },
    });
    expect(await page(id)).toMatchObject({
      items: [
        {
          versionBasis: { type: "inferred", kind: "decision_date" },
          selection: "misprint-correction",
          printedWorkIdentifier: "98/2012 Sb.",
        },
        { spanStart: 20 },
      ],
      status: { type: "current" },
      generation: "1",
      publishedProjectionDigest: PROJECTION_DIGEST,
    });
  } finally {
    await setStatusGrants("grant");
  }
});

test("status precedence uses the decision, scope, and current payload before publication", async () => {
  const outOfScope = await decision({ language: "sk" });
  const outOfScopeWithheld = await decision({ language: "sk", redacted: true });
  const withheld = await decision({ redacted: true });
  const unavailable = await decision({
    contentHash:
      EMPTY_CORPUS_CONTENT_HASHES.at(0) ?? panic("Missing empty corpus hash"),
  });
  const nullHashEnvelope = await decision({ contentHash: null });
  const unplaceable = await decision();
  const nullHash = await decision({ contentHash: null });
  const failed = await decision();
  await setState(
    unplaceable,
    sql`payload_class = 'unusable', payload_class_input_digest = desired_input_digest`,
  );
  await setState(
    failed,
    sql`work_status = 'blocked', blocked_input_digest = desired_input_digest`,
  );
  await setState(
    nullHashEnvelope,
    sql`payload_class = 'empty_envelope', payload_class_input_digest = desired_input_digest`,
  );
  await citation({
    decisionId: withheld,
    spanStart: 10,
    anchor: "old-excerpt",
  });
  for (const id of [withheld, unavailable, unplaceable, failed]) {
    await extracted({
      id,
      outcome: id === withheld ? "extracted_with_rows" : "extracted_zero",
    });
  }

  for (const [id, type] of [
    [outOfScope, "out_of_scope"],
    [outOfScopeWithheld, "out_of_scope"],
    [withheld, "withheld"],
    [unavailable, "unavailable"],
    [nullHashEnvelope, "unavailable"],
    [unplaceable, "unplaceable"],
    [nullHash, "unplaceable"],
    [failed, "failed"],
  ] as const) {
    expect(await page(id)).toMatchObject({
      items: [],
      nextCursor: null,
      status: { type },
    });
  }
});

test("payload classifications apply only to the current input digest", async () => {
  const id = await decision();
  await setState(
    id,
    sql`payload_class = 'empty_envelope',
      payload_class_input_digest = sha256('old input'::bytea)`,
  );
  expect(await page(id)).toMatchObject({ status: { type: "pending" } });
  await setState(id, sql`payload_class_input_digest = desired_input_digest`);
  expect(await page(id)).toMatchObject({ status: { type: "unavailable" } });
});

test("current publication requires the actual input, desired input, country, and revision floor", async () => {
  const readyRows = await decision();
  const readyZero = await decision();
  const wrongCountry = await decision();
  const belowFloor = await decision();
  const desiredMismatch = await decision();
  const missedEnqueue = await decision();
  for (const id of [
    readyRows,
    readyZero,
    wrongCountry,
    belowFloor,
    desiredMismatch,
    missedEnqueue,
  ]) {
    await extracted({
      id,
      outcome: id === readyZero ? "extracted_zero" : "extracted_with_rows",
      revision: id === belowFloor || id === wrongCountry ? 1 : 2,
      jurisdiction: id === wrongCountry ? "SVK" : "CZE",
    });
  }
  await citation({
    decisionId: readyRows,
    spanStart: 10,
    anchor: "a",
    printedWorkIdentifier: "98/2012 Sb.",
  });
  await run(sql`UPDATE case_law_provision_citations
    SET span_role = 'printed', print_piece_id = 'p-1', print_start = 0,
      print_end = 3, print_text = '§ 1', name_piece_id = 'p-2',
      name_start = 4, name_end = 15, name_text = '98/2012 Sb.',
      target_status = 'work_not_held'
    WHERE decision_id = ${readyRows}`);
  for (const decisionId of [
    wrongCountry,
    belowFloor,
    desiredMismatch,
    missedEnqueue,
  ]) {
    await citation({ decisionId, spanStart: 10, anchor: "a" });
  }
  await run(sql`UPDATE case_law_provision_extraction_revisions
    SET min_current_revision = 2 WHERE jurisdiction = 'CZE'`);
  await setState(
    desiredMismatch,
    sql`desired_input_digest = sha256('desired moved'::bytea)`,
  );
  await setState(
    missedEnqueue,
    sql`desired_input_digest = sha256('desired moved'::bytea),
      published_input_digest = sha256('desired moved'::bytea)`,
  );

  expect(await page(readyRows)).toMatchObject({
    items: [
      {
        selection: "misprint-correction",
        printedWorkIdentifier: "98/2012 Sb.",
        workIdentifier: "89/2012 Sb.",
        spanRole: "printed",
        printPieceId: "p-1",
        printStart: 0,
        printEnd: 3,
        printText: "§ 1",
        namePieceId: "p-2",
        nameStart: 4,
        nameEnd: 15,
        nameText: "98/2012 Sb.",
        targetDocumentId: null,
        targetStatus: "work_not_held",
      },
    ],
    status: { type: "current" },
    publishedProjectionDigest: PROJECTION_DIGEST,
  });
  expect(await page(readyZero)).toMatchObject({
    items: [],
    status: { type: "current" },
    publishedProjectionDigest: PROJECTION_DIGEST,
  });
  for (const id of [wrongCountry, belowFloor, desiredMismatch, missedEnqueue]) {
    expect(await page(id)).toMatchObject({ status: { type: "stale" } });
  }
});

test("existing rows without publication are legacy; no rows or state are pending", async () => {
  const legacy = await decision();
  const pending = await decision();
  const missingState = await decision();
  await citation({ decisionId: legacy, spanStart: 10, anchor: "a" });
  await run(sql`DELETE FROM case_law_provision_extractions
    WHERE decision_id = ${missingState}`);
  expect(await page(legacy)).toMatchObject({ status: { type: "legacy" } });
  expect(await page(pending)).toMatchObject({ status: { type: "pending" } });
  expect(await page(missingState)).toMatchObject({
    status: { type: "pending" },
    generation: "0",
    publishedProjectionDigest: null,
  });
});

test("terminal publication is stale even when its input matches", async () => {
  const id = await decision();
  await setState(
    id,
    sql`generation = 1, outcome = 'terminal', terminal_reason = 'unplaceable',
      published_input_digest = desired_input_digest, published_at = now()`,
  );
  expect(await page(id)).toMatchObject({ status: { type: "stale" } });
});

test("cursor binds to the full bigint generation and orders span then anchor", async () => {
  const id = await decision();
  await extracted({ id, outcome: "extracted_with_rows" });
  await setState(id, sql`generation = 9007199254740993`);
  await citation({ decisionId: id, spanStart: 10, anchor: "a" });
  await citation({ decisionId: id, spanStart: 10, anchor: "b" });
  await citation({ decisionId: id, spanStart: 20, anchor: "a" });
  const first = await page(id);
  expect(first).toMatchObject({
    items: [
      { spanStart: 10, anchor: "a" },
      { spanStart: 10, anchor: "b" },
    ],
    generation: "9007199254740993",
    status: { type: "current" },
  });
  if (!("items" in first) || first.nextCursor === null) {
    panic("expected first cursor page");
  }
  expect(first.nextCursor).toBe(
    encodePaginationCursor(["9007199254740993", 10, "b"]),
  );
  expect(await page(id, first.nextCursor)).toMatchObject({
    items: [{ spanStart: 20, anchor: "a" }],
    nextCursor: null,
  });
  await citation({ decisionId: id, spanStart: 5, anchor: "new" });
  await setState(id, sql`generation = generation + 1`);
  expect(await page(id, first.nextCursor)).toMatchObject({
    code: 409,
    response: { type: "conflict" },
  });
  expect(
    await page(id, encodePaginationCursor(["9007199254740992", 10, "b"])),
  ).toMatchObject({
    code: 409,
    response: { type: "conflict" },
  });
});

test("malformed cursors fail before a page is returned", async () => {
  const id = await decision();
  for (const cursor of [
    "not-a-cursor",
    encodePaginationCursor([10, "a"]),
    encodePaginationCursor(["1", "10", "a"]),
    encodePaginationCursor(["1", 10, 5]),
    encodePaginationCursor(["01", 10, "a"]),
    encodePaginationCursor(["1", -1, "a"]),
    encodePaginationCursor(["1", 2_147_483_648, "a"]),
  ]) {
    expect(await page(id, cursor)).toMatchObject({ code: 400 });
  }
});
