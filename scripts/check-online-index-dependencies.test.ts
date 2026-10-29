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

test("schema index declarations do not consume index readiness", () => {
  expect(
    check(
      'uniqueIndex("chat_turns_org_run_id_uidx").on(chatTurns.organizationId, chatTurns.runId)',
    ),
  ).toEqual([]);
  expect(
    check('error.constraint_name === "chat_turns_org_run_id_uidx"').at(0)?.name,
  ).toBe(index.name);
});
