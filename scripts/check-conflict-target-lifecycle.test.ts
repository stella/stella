import { describe, expect, test } from "bun:test";
import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import {
  DEPLOY_BLOCKING,
  ONLINE_WORK_LIFECYCLE,
  PENDING,
} from "../apps/api/src/db/online-work-lifecycle";
import { defineScopedTransitions } from "../apps/api/src/lib/db/transitions";
import {
  checkConflictTargetSource,
  checkRepositoryConflictTargets,
  type ConflictTargetContext,
  DECLARED_CONFLICT_TARGETS,
  repositoryConflictTargetContext,
} from "./check-conflict-target-lifecycle";

const repository = repositoryConflictTargetContext();
const ARBITER = "contacts_org_external_uidx";

const withArbiter = (
  state: typeof PENDING | typeof DEPLOY_BLOCKING,
): ConflictTargetContext => ({
  ...repository,
  lifecycle: { ...ONLINE_WORK_LIFECYCLE, [ARBITER]: state },
});

const check = (body: string, context: ConflictTargetContext) =>
  checkConflictTargetSource({
    file: "apps/api/src/lib/imports/fixture.ts",
    source: `import { contacts } from "@/api/db/schema";
import {
  CONTACTS_ORG_EXTERNAL_UIDX,
  ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexTarget,
} from "@/api/db/online-unique-indexes";
${body}
`,
    context,
  }).map(({ reason }) => reason);

const PENDING_REASON = `conflict target ${ARBITER} is pending online work, which no migrate run builds; register it DEPLOY_BLOCKING or target an index the migrate step builds`;

const ARBITER_TARGETS = {
  columns:
    "tx.insert(contacts).values(rows).onConflictDoUpdate({ target: [contacts.organizationId, contacts.externalSource, contacts.externalId], set });",
  "named constant":
    "tx.insert(contacts).values(rows).onConflictDoUpdate({ target: onlineUniqueIndexTarget(CONTACTS_ORG_EXTERNAL_UIDX, contacts), set });",
  "name registry":
    "tx.insert(contacts).values(rows).onConflictDoNothing({ target: onlineUniqueIndexTarget(ONLINE_UNIQUE_INDEX_NAMES.CONTACTS_ORG_EXTERNAL_UIDX, contacts) });",
  "local constant":
    "const TARGET = [contacts.organizationId, contacts.externalSource, contacts.externalId];\ntx.insert(contacts).values(rows).onConflictDoNothing({ target: TARGET });",
  "raw SQL":
    "tx.execute(sql`INSERT INTO contacts (id) VALUES (1) ON CONFLICT (organization_id, external_source, external_id) DO NOTHING`);",
  "raw SQL on a table binding": `tx.execute(sql\`INSERT INTO \${contacts} (id) VALUES (1) ON CONFLICT (organization_id, external_source, external_id) DO NOTHING\`);`,
  "raw constraint":
    "tx.execute(sql`INSERT INTO contacts (id) VALUES (1) ON CONFLICT ON CONSTRAINT contacts_org_external_uidx DO NOTHING`);",
} as const;

describe("ON CONFLICT targets and the online work lifecycle", () => {
  test.each(Object.entries(ARBITER_TARGETS))(
    "a pending index used as a conflict target fails (%s)",
    (_shape, body) => {
      expect(check(body, withArbiter(PENDING))).toEqual([PENDING_REASON]);
    },
  );

  test.each(Object.entries(ARBITER_TARGETS))(
    "a deploy-blocking index is a valid conflict target (%s)",
    (_shape, body) => {
      expect(check(body, withArbiter(DEPLOY_BLOCKING))).toEqual([]);
    },
  );

  test("a key the SQL migrations build passes, an undeclared one fails", () => {
    expect(
      check(
        "tx.insert(contacts).values(rows).onConflictDoNothing({ target: contacts.id });",
        repository,
      ),
    ).toEqual([]);
    expect(
      check(
        "tx.insert(contacts).values(rows).onConflictDoNothing({ target: contacts.notes });",
        repository,
      ),
    ).toEqual([
      "conflict target contacts(notes) matches no unique key the schema declares",
    ]);
  });

  test("a target the guard cannot resolve fails instead of passing", () => {
    expect(
      check(
        "const upsert = (table) => tx.insert(table).values(rows).onConflictDoNothing({ target: [table.organizationId, table.externalId] });",
        repository,
      ),
    ).toEqual([
      "conflict target cannot be resolved to a unique index (table is no single schema table); name it inline or through onlineUniqueIndexTarget",
    ]);
    expect(
      check(
        "tx.insert(contacts).values(rows).onConflictDoUpdate(options);",
        repository,
      ),
    ).toEqual([
      "conflict target cannot be resolved to a unique index (options is no local constant); name it inline or through onlineUniqueIndexTarget",
    ]);
  });

  test("a target-free ON CONFLICT DO NOTHING names no arbiter", () => {
    expect(
      check(
        "tx.insert(contacts).values(rows).onConflictDoNothing();\ntx.execute(sql`INSERT INTO contacts (id) VALUES (1) ON CONFLICT DO NOTHING`);",
        repository,
      ),
    ).toEqual([]);
  });

  test("a declared conflict target's owner refuses an identity on pending online work", () => {
    expect(DECLARED_CONFLICT_TARGETS.map(({ owner }) => owner)).toEqual([
      "defineScopedTransitions",
    ]);
    const pendingNames = new Set(
      Object.entries(ONLINE_WORK_LIFECYCLE).flatMap(([name, { state }]) =>
        state === "pending" ? [name] : [],
      ),
    );
    const pending = repository.onlineIndexes.find(({ name }) =>
      pendingNames.has(name),
    );
    if (pending === undefined) {
      throw new TypeError("Expected a pending online unique index");
    }
    const fixture = pgTable(
      "conflict_target_fixture",
      {
        id: text().notNull(),
        tenant: text().notNull(),
        state: text({ enum: ["open", "closed"] }).notNull(),
      },
      (table) => [uniqueIndex(pending.name).on(table.id, table.tenant)],
    );
    expect(() =>
      defineScopedTransitions({
        table: fixture,
        key: "id",
        scope: ["tenant"],
        stateColumn: "state",
        edges: { open: ["closed"], closed: [] },
        initial: ["open"],
      }),
    ).toThrow(
      `A scoped transition identity rests on pending online work (${pending.name}); register it DEPLOY_BLOCKING`,
    );
  });

  test("every conflict target in the API resolves to migrate-built work", () => {
    expect(checkRepositoryConflictTargets(repository)).toEqual([]);
  });
});
