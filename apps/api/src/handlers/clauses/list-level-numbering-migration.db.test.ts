import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import * as v from "valibot";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { clauses, clauseVariants, clauseVersions } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { clauseBodySchema } from "@/api/lib/clauses/body-schema";
import { type ClauseBody, normalizeClauseBody } from "@/api/lib/clauses/types";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { getClauseHandler, getClauseVersionHandler } from "./read";
import { updateClauseHandler } from "./update";

/**
 * Stored clause bodies from before folio's numbering API carry list depth as
 * `listLevel` / `list_level`. The migration moves it to `numbering`, which is
 * the only depth the normalizer and the body schema read. The shared test
 * database boots with every migration already applied and no such rows, so
 * the suite writes bodies in the old shape and runs the migration file itself.
 */
const MIGRATION_FILE = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20261015060100_clause_list_level_numbering/migration.sql",
);

// The schema strips undeclared keys, so a body is one it writes only when
// decoding keeps every key it carries.
const isWrittenBody = (body: unknown) => {
  const decoded = v.safeParse(clauseBodySchema, body);
  return decoded.success && Bun.deepEquals(decoded.output, body);
};

const levelOnly = (ilvl: number) => ({ kind: "levelOnly", ilvl }) as const;

/** As the previous body schema stored it, including import extensions. */
const LEGACY_CLAUSE_BODY = [
  { text: "Parties", listKind: "ordered", listLevel: 0 },
  {
    text: "Seller",
    listKind: "ordered",
    listLevel: 1,
    runs: [{ text: "Seller", bold: true }],
    extra: { source: "import" },
  },
  { text: "Seller's address", listKind: "bullet", list_level: 2 },
  { text: "Plain paragraph", style: "Body" },
];

const MIGRATED_CLAUSE_BODY = [
  { text: "Parties", listKind: "ordered", numbering: levelOnly(0) },
  {
    text: "Seller",
    listKind: "ordered",
    numbering: levelOnly(1),
    runs: [{ text: "Seller", bold: true }],
    extra: { source: "import" },
  },
  { text: "Seller's address", listKind: "bullet", numbering: levelOnly(2) },
  { text: "Plain paragraph", style: "Body" },
];

/** Depths the old schema admitted that the numbering range does not. */
const LEGACY_EDGE_BODY = [
  { text: "camel wins", listKind: "bullet", listLevel: 1, list_level: 3 },
  {
    text: "null falls back",
    listKind: "bullet",
    listLevel: null,
    list_level: 2,
  },
  { text: "too deep", listKind: "bullet", listLevel: 12 },
  { text: "negative", listKind: "bullet", listLevel: -1 },
  { text: "fractional", listKind: "bullet", listLevel: 1.5 },
  { text: "string", listKind: "bullet", listLevel: "2" },
];

const MIGRATED_EDGE_BODY = [
  { text: "camel wins", listKind: "bullet", numbering: levelOnly(1) },
  { text: "null falls back", listKind: "bullet", numbering: levelOnly(2) },
  {
    text: "too deep",
    listKind: "bullet",
    numbering: levelOnly(LIMITS.clauseNumberingLevelMax),
  },
  {
    text: "negative",
    listKind: "bullet",
    numbering: levelOnly(LIMITS.clauseNumberingLevelMin),
  },
  { text: "fractional", listKind: "bullet" },
  { text: "string", listKind: "bullet" },
];

const VARIANT_BODY = [
  { text: "Variant item", listKind: "bullet", listLevel: 1 },
];
const VERSION_BODY = [
  { text: "Version item", listKind: "ordered", list_level: 2 },
];

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const clauseId = createSafeId<"clause">();
const edgeClauseId = createSafeId<"clause">();
const variantId = createSafeId<"clauseVariant">();
const versionId = createSafeId<"clauseVersion">();

const applyMigration = async (): Promise<void> => {
  const statements = readFileSync(MIGRATION_FILE, "utf-8")
    .split("--> statement-breakpoint")
    .filter((statement) => statement.trim().length > 0);
  await testDb.transaction(async (tx) => {
    for (const statement of statements) {
      // Sequential on purpose: the functions precede the rewrites using them.
      await tx.execute(sql.raw(statement));
    }
  });
};

const storedBody = async (id: SafeId<"clause">): Promise<unknown> =>
  (
    await testDb
      .select({ body: clauses.body })
      .from(clauses)
      .where(eq(clauses.id, id))
  ).at(0)?.body;

const storedRows = async () => ({
  clause: await storedBody(clauseId),
  edge: await storedBody(edgeClauseId),
  variant: (
    await testDb
      .select({ body: clauseVariants.body })
      .from(clauseVariants)
      .where(eq(clauseVariants.id, variantId))
  ).at(0)?.body,
  version: (
    await testDb
      .select({ body: clauseVersions.body })
      .from(clauseVersions)
      .where(eq(clauseVersions.id, versionId))
  ).at(0)?.body,
});

beforeAll(async () => {
  ({ testDb, ids } = await getRlsFixture());
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
  await testDb.insert(clauses).values([
    {
      id: clauseId,
      organizationId: ids.orgA,
      title: "Legacy nested clause",
      body: asTestRaw<ClauseBody>(LEGACY_CLAUSE_BODY),
      createdBy: ids.userA1,
    },
    {
      id: edgeClauseId,
      organizationId: ids.orgA,
      title: "Legacy edge depths",
      body: asTestRaw<ClauseBody>(LEGACY_EDGE_BODY),
      createdBy: ids.userA1,
    },
  ]);
  await testDb.insert(clauseVariants).values({
    id: variantId,
    organizationId: ids.orgA,
    clauseId,
    label: "Variant",
    body: asTestRaw<ClauseBody>(VARIANT_BODY),
  });
  await testDb.insert(clauseVersions).values({
    id: versionId,
    organizationId: ids.orgA,
    clauseId,
    version: 1,
    body: asTestRaw<ClauseBody>(VERSION_BODY),
  });
  await applyMigration();
}, 60_000);

afterAll(async () => {
  await testDb
    .delete(clauses)
    .where(inArray(clauses.id, [clauseId, edgeClauseId]));
  await releaseRlsFixture();
});

test("every stored body moves its list depth to numbering", async () => {
  expect(await storedRows()).toEqual({
    clause: MIGRATED_CLAUSE_BODY,
    edge: MIGRATED_EDGE_BODY,
    variant: [
      { text: "Variant item", listKind: "bullet", numbering: levelOnly(1) },
    ],
    version: [
      { text: "Version item", listKind: "ordered", numbering: levelOnly(2) },
    ],
  });
});

test("a re-run changes nothing", async () => {
  const before = await storedRows();
  await applyMigration();
  expect(await storedRows()).toEqual(before);
});

test("the normalizer keeps the migrated nesting and the schema accepts it", () => {
  for (const body of [MIGRATED_CLAUSE_BODY, MIGRATED_EDGE_BODY]) {
    const normalized = normalizeClauseBody(body);
    expect(normalized.map((paragraph) => paragraph.numbering)).toEqual(
      body.map((paragraph) =>
        "numbering" in paragraph ? paragraph.numbering : undefined,
      ),
    );
    expect(isWrittenBody(normalized)).toBe(true);
  }
});

test("reading, editing and saving a migrated clause keeps its nesting", async () => {
  const read = await Result.gen(() =>
    getClauseHandler({ safeDb, organizationId: ids.orgA, clauseId }),
  );
  const clause = read.unwrap();
  expect(clause.body).toEqual(normalizeClauseBody(MIGRATED_CLAUSE_BODY));
  expect(clause.variants.map((variant) => variant.body)).toEqual([
    [{ text: "Variant item", listKind: "bullet", numbering: levelOnly(1) }],
  ]);
  const version = await Result.gen(() =>
    getClauseVersionHandler({
      safeDb,
      organizationId: ids.orgA,
      clauseId,
      versionId,
    }),
  );
  expect(version.unwrap().body).toEqual([
    { text: "Version item", listKind: "ordered", numbering: levelOnly(2) },
  ]);

  const edited: ClauseBody = clause.body.map((paragraph, index) =>
    index === 1
      ? { ...paragraph, text: "Seller and its successors" }
      : paragraph,
  );
  expect(isWrittenBody(edited)).toBe(true);
  const saved = await Result.gen(() =>
    updateClauseHandler({
      safeDb,
      organizationId: ids.orgA,
      clauseId,
      body: { body: edited, expectedBody: clause.body },
      recordAuditEvent: async () => undefined,
    }),
  );
  expect(Result.isOk(saved)).toBe(true);

  expect(await storedBody(clauseId)).toEqual(edited);
  const reread = await Result.gen(() =>
    getClauseHandler({ safeDb, organizationId: ids.orgA, clauseId }),
  );
  expect(reread.unwrap().body.map((paragraph) => paragraph.numbering)).toEqual([
    levelOnly(0),
    levelOnly(1),
    levelOnly(2),
    undefined,
  ]);
});
