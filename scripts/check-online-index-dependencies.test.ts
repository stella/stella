import { expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";

import {
  CHAT_TURNS_ORG_RUN_ID_UIDX,
  onlineIndexColumnTarget,
  onlineUniqueIndexTarget,
} from "../apps/api/src/db/online-unique-indexes";
import { checkOnlineIndexDependencySource } from "./check-online-index-dependencies";

const index = {
  name: "chat_turns_org_run_id_uidx",
  definitionBody: "ON public.chat_turns USING btree (organization_id, run_id)",
  introducedBy: "20261017000000_latest",
  tableName: "chat_turns",
};
const check = (source: string, introducedBy = index.introducedBy) =>
  checkOnlineIndexDependencySource({
    file: "apps/api/src/handlers/example.ts",
    source,
    indexes: [{ ...index, introducedBy }],
    newestMigration: "20261017000000_latest",
  });

test("rejects a dependency through an aliased newest index constant", () => {
  const findings = check(
    'import { CHAT_TURNS_ORG_RUN_ID_UIDX as RUN_INDEX } from "../db/online-unique-indexes"; query.onConflictDoUpdate({ target: onlineUniqueIndexTarget(RUN_INDEX), set: row });',
  );
  expect(findings.map(({ reason }) => reason)).toEqual([
    "depends on newest migration 20261017000000_latest",
  ]);
});

test.each([
  "query.onConflictDoUpdate({ target: [chatTurns.organizationId, chatTurns.runId], set: row });",
  "query.onConflictDoNothing({ target: [chatTurns.runId, chatTurns.organizationId] });",
  'await query(sql`INSERT INTO chat_turns VALUES (1) ON CONFLICT ("organization_id", run_id) DO NOTHING`);',
])("rejects unbound conflict columns: %s", (source) => {
  expect(check(source).map(({ name }) => name)).toEqual([index.name]);
});

test("permits older named conflict targets", () => {
  expect(
    check(
      "query.onConflictDoUpdate({ target: onlineUniqueIndexTarget(CHAT_TURNS_ORG_RUN_ID_UIDX), set: row });",
      "20261016000000_prior",
    ),
  ).toEqual([]);
});

test("rejects raw names of older unique steps", () => {
  expect(
    check(
      'error.constraint_name === "chat_turns_org_run_id_uidx"',
      "20261016000000_prior",
    ).at(0)?.reason,
  ).toBe("raw index name; use the exported index constant");
});

test("scopes matching columns to the target table", () => {
  expect(
    check(
      "query.onConflictDoUpdate({ target: [otherTable.organizationId, otherTable.runId], set: row });",
    ),
  ).toEqual([]);
});

test("detects namespace dependencies in schema modules too", () => {
  const findings = checkOnlineIndexDependencySource({
    file: "apps/api/src/db/schema/example.ts",
    source: "uniqueIndex(names.CHAT_TURNS_ORG_RUN_ID_UIDX)",
    indexes: [index],
    newestMigration: index.introducedBy,
  });
  expect(findings.at(0)?.reason).toBe(
    `depends on newest migration ${index.introducedBy}`,
  );
});

test("detects nested expression conflict targets", () => {
  const expressionIndex = {
    ...index,
    definitionBody:
      "ON public.chat_turns USING btree (organization_id, lower((content ->> 'key'::text)))",
  };
  const findings = checkOnlineIndexDependencySource({
    file: "apps/api/src/handlers/example.ts",
    source:
      "query(sql`INSERT INTO chat_turns VALUES (1) ON CONFLICT (organization_id, lower((content ->> 'key'::text))) DO NOTHING`)",
    indexes: [expressionIndex],
    newestMigration: index.introducedBy,
  });
  expect(findings.at(0)?.name).toBe(index.name);
});

test("named conflict targets render the same column inference with Drizzle", () => {
  const table = pgTable("chat_turns", {
    organizationId: text("organization_id"),
    runId: text("run_id"),
  });
  const db = drizzle(async () => ({ rows: [] }));
  const original = db
    .insert(table)
    .values({ organizationId: "organization", runId: "run" })
    .onConflictDoNothing({ target: [table.organizationId, table.runId] })
    .toSQL();
  const named = db
    .insert(table)
    .values({ organizationId: "organization", runId: "run" })
    .onConflictDoNothing({
      target: onlineUniqueIndexTarget(CHAT_TURNS_ORG_RUN_ID_UIDX, table),
    })
    .toSQL();
  expect(named).toEqual(original);
});

test("keeps the full nested expression target", () => {
  expect(
    onlineIndexColumnTarget(
      "ON public.templates USING btree (organization_id, ((origin ->> 'packId'::text)), ((origin ->> 'slug'::text))) WHERE (origin_type = 'bundled-pack'::text)",
    ),
  ).toBe(
    "organization_id, ((origin ->> 'packId'::text)), ((origin ->> 'slug'::text))",
  );
});

test.each([
  'uniqueIndex("chat_turns_org_run_id_uidx").on(chatTurns.organizationId, chatTurns.runId)',
  'p.uniqueIndex("chat_turns_org_run_id_uidx").on(chatTurns.organizationId, chatTurns.runId)',
  'p.unique("chat_turns_org_run_id_uidx").on(chatTurns.organizationId, chatTurns.runId)',
  'namespace.uniqueIndex("chat_turns_org_run_id_uidx").on(chatTurns.organizationId, chatTurns.runId)',
  'schemaPg.unique("chat_turns_org_run_id_uidx").on(chatTurns.organizationId, chatTurns.runId)',
  'defineUnique("chat_turns_org_run_id_uidx").on(chatTurns.organizationId, chatTurns.runId)',
  'export const ACTIVE_INDEX = "chat_turns_org_run_id_uidx"; p.uniqueIndex(ACTIVE_INDEX).on(chatTurns.organizationId, chatTurns.runId)',
])("schema index declarations do not consume index readiness: %s", (source) => {
  expect(
    checkOnlineIndexDependencySource({
      file: "apps/api/src/db/schema/example.ts",
      source: `import { uniqueIndex, unique as defineUnique } from "drizzle-orm/pg-core"; import * as namespace from "drizzle-orm/pg-core"; import { p } from "./common"; import { p as schemaPg } from "@/api/db/schema/common";\n${source}`,
      indexes: [index],
      newestMigration: index.introducedBy,
    }),
  ).toEqual([]);
  expect(
    check('error.constraint_name === "chat_turns_org_run_id_uidx"').at(0)?.name,
  ).toBe(index.name);
});

test.each([
  'p.uniqueIndex("chat_turns_org_run_id_uidx"); error.constraint_name === "chat_turns_org_run_id_uidx"',
])("schema modules retain runtime dependency enforcement: %s", (source) => {
  const findings = checkOnlineIndexDependencySource({
    file: "apps/api/src/db/schema/example.ts",
    source: `import { p } from "./common";\n${source}`,
    indexes: [index],
    newestMigration: index.introducedBy,
  });
  expect(findings.map(({ name }) => name)).toEqual([index.name]);
  expect(findings.some(({ reason }) => reason.startsWith("raw "))).toBe(true);
});

test.each([
  "error.constraint_name === ACTIVE_INDEX",
  "query.onConflictDoNothing({ target: [chatTurns.organizationId, chatTurns.runId] })",
])("a declaration binding does not hide its runtime use: %s", (runtime) => {
  const findings = checkOnlineIndexDependencySource({
    file: "apps/api/src/db/schema/example.ts",
    source: `import { p } from "./common";\nexport const ACTIVE_INDEX = "chat_turns_org_run_id_uidx";\np.uniqueIndex(ACTIVE_INDEX);\n${runtime}`,
    indexes: [index],
    newestMigration: index.introducedBy,
  });
  expect(findings.map(({ line }) => line)).toEqual([4]);
  expect(findings.at(0)?.reason).toMatch(/^raw /u);
});

test.each([
  'other.uniqueIndex("chat_turns_org_run_id_uidx")',
  'other.unique("chat_turns_org_run_id_uidx")',
  'uniqueIndex("chat_turns_org_run_id_uidx")',
  'import { p } from "./common"; const run = (p) => p.uniqueIndex("chat_turns_org_run_id_uidx")',
  'import { uniqueIndex } from "drizzle-orm/pg-core"; const run = (uniqueIndex) => uniqueIndex("chat_turns_org_run_id_uidx")',
  'import * as pg from "drizzle-orm/pg-core"; const run = (pg) => pg.unique("chat_turns_org_run_id_uidx")',
  'import { p } from "./other"; p.uniqueIndex("chat_turns_org_run_id_uidx")',
])("unbound or shadowed builders remain runtime dependencies: %s", (source) => {
  expect(check(source).at(0)?.reason).toBe(
    "raw index name; use the exported index constant",
  );
});

test("a shadowed declaration binding does not authorize a runtime name initializer", () => {
  const findings = checkOnlineIndexDependencySource({
    file: "apps/api/src/db/schema/example.ts",
    source: `import { p } from "./common";
export const ACTIVE_INDEX = "chat_turns_org_run_id_uidx";
const build = (ACTIVE_INDEX) => p.uniqueIndex(ACTIVE_INDEX);
error.constraint_name === ACTIVE_INDEX;`,
    indexes: [index],
    newestMigration: index.introducedBy,
  });
  expect(findings.map(({ line }) => line)).toEqual([2]);
});
