import { describe, expect, expectTypeOf, test } from "bun:test";
import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import {
  type ConflictTargetIndexName,
  CONTACTS_ORG_EXTERNAL_UIDX,
} from "../apps/api/src/db/online-unique-indexes";
import {
  DEPLOY_BLOCKING,
  ONLINE_WORK_LIFECYCLE,
  PENDING,
} from "../apps/api/src/db/online-work-lifecycle";
import { defineScopedTransitions } from "../apps/api/src/lib/db/transitions";
import {
  checkConflictTargetSource,
  checkRepositoryConflictTargets,
  CONFLICT_TARGET_OWNER,
  type ConflictTargetContext,
  conflictTargetSourceFiles,
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

const check = (
  body: string,
  context: ConflictTargetContext,
  file = "apps/api/src/lib/imports/fixture.ts",
) =>
  checkConflictTargetSource({
    file,
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
const unresolved = (reason: string) =>
  `conflict target cannot be resolved to a unique index (${reason}); name it inline or through onlineUniqueIndexTarget`;

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
    ).toEqual([unresolved("table is no single schema table")]);
    expect(
      check(
        "tx.insert(contacts).values(rows).onConflictDoUpdate(options);",
        repository,
      ),
    ).toEqual([unresolved("options is no local constant")]);
  });

  test("a raw target on a table the schema does not know, or with a hole for a column, fails", () => {
    expect(
      check(
        "tx.execute(sql`INSERT INTO unknown_rows (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);",
        repository,
      ),
    ).toEqual([unresolved("unknown_rows is no schema table")]);
    for (const [source, read] of [
      [`\${column}`, "__CONFLICT_HOLE_0__"],
      [`organization_id, \${column}`, "organization_id, __CONFLICT_HOLE_0__"],
    ] as const) {
      expect(
        check(
          `tx.execute(sql\`INSERT INTO contacts (id) VALUES (1) ON CONFLICT (${source}) DO NOTHING\`);`,
          repository,
        ),
      ).toEqual([
        unresolved(`raw target contacts(${read}) is no table and column list`),
      ]);
    }
  });

  test("a name a parameter or other binding shadows does not resolve", () => {
    expect(
      check(
        "const TARGET = [contacts.id];\nconst write = (TARGET) => tx.insert(contacts).values(rows).onConflictDoNothing({ target: TARGET });",
        repository,
      ),
    ).toEqual([unresolved("TARGET is no local constant")]);
    expect(
      check(
        "const write = (contacts) => tx.insert(contacts).values(rows).onConflictDoNothing({ target: contacts.id });",
        repository,
      ),
    ).toEqual([unresolved("contacts is no single schema table")]);
    expect(
      check(
        "const write = ({ onlineUniqueIndexTarget }) => tx.insert(contacts).values(rows).onConflictDoNothing({ target: onlineUniqueIndexTarget(CONTACTS_ORG_EXTERNAL_UIDX, contacts) });",
        withArbiter(DEPLOY_BLOCKING),
      ),
    ).toEqual([
      unresolved(
        "onlineUniqueIndexTarget(CONTACTS_ORG_EXTERNAL_UIDX, contacts) is no table column",
      ),
    ]);
  });

  test("a declared unique key with a lifecycle entry is held to it, whatever its registered shape", () => {
    const fixture = pgTable(
      "conflict_target_fixture",
      { id: text().notNull(), tenant: text().notNull() },
      (table) => [
        uniqueIndex("fixture_tenant_uidx").on(table.tenant, table.id),
      ],
    );
    const context = (
      onlineIndexes: ConflictTargetContext["onlineIndexes"],
    ): ConflictTargetContext => ({
      tables: new Map([["conflictTargetFixture", fixture]]),
      onlineIndexes,
      indexNameConstants: {},
      lifecycle: { fixture_tenant_uidx: PENDING },
    });
    const source = `import { conflictTargetFixture } from "@/api/db/schema";
tx.insert(conflictTargetFixture).values(rows).onConflictDoNothing({ target: [conflictTargetFixture.tenant, conflictTargetFixture.id] });`;
    const pending =
      "conflict target fixture_tenant_uidx is pending online work, which no migrate run builds; register it DEPLOY_BLOCKING or target an index the migrate step builds";
    for (const onlineIndexes of [
      // Registered as an expression index the column target does not match.
      [
        {
          name: "fixture_tenant_uidx",
          tableName: "conflict_target_fixture",
          columns: ["lower(tenant)", "id"],
        },
      ],
      // Or not in the online registry at all.
      [],
    ]) {
      expect(
        checkConflictTargetSource({
          file: "apps/api/src/fixture.ts",
          source,
          context: context(onlineIndexes),
        }).map(({ reason }) => reason),
      ).toEqual([pending]);
    }
  });

  test("a target-free ON CONFLICT DO NOTHING names no arbiter", () => {
    expect(
      check(
        "tx.insert(contacts).values(rows).onConflictDoNothing();\ntx.execute(sql`INSERT INTO contacts (id) VALUES (1) ON CONFLICT DO NOTHING`);",
        repository,
      ),
    ).toEqual([]);
  });

  test("a target built at runtime resolves only through the owner symbol", () => {
    const owned = `import { ${CONFLICT_TARGET_OWNER.symbol} } from "@/api/lib/db/transitions";
tx.execute(sql\`INSERT INTO \${spec.table} (id) VALUES (1) ON CONFLICT (\${${CONFLICT_TARGET_OWNER.symbol}(spec)}) DO NOTHING\`);`;
    expect(check(owned, repository)).toEqual([]);
    const elsewhere = owned.replace(
      "@/api/lib/db/transitions",
      "@/api/lib/db/other",
    );
    const inOwnerFile = `tx.execute(sql\`INSERT INTO \${spec.table} (id) VALUES (1) ON CONFLICT (\${sql.join(identityColumns.map((column) => sql.identifier(column.name)), sql\`, \`)}) DO NOTHING\`);`;
    const shadowed = `${owned}\nconst run = (${CONFLICT_TARGET_OWNER.symbol}) => undefined;`;
    for (const [body, file] of [
      [elsewhere, undefined],
      [inOwnerFile, CONFLICT_TARGET_OWNER.file],
      [shadowed, undefined],
    ] as const) {
      expect(check(body, repository, file)).toEqual([
        unresolved(
          "raw target __CONFLICT_HOLE_0__(__CONFLICT_HOLE_1__) is no table and column list",
        ),
      ]);
    }
  });

  test("the guard reads the API's scripts as well as its sources", () => {
    expect(conflictTargetSourceFiles()).toEqual(
      expect.arrayContaining([
        "apps/api/scripts/classify-citations.ts",
        "apps/api/src/lib/imports/upsert-by-external-id.ts",
      ]),
    );
  });

  test("every conflict target in the API resolves to migrate-built work", () => {
    expect(checkRepositoryConflictTargets(repository)).toEqual([]);
  });
});

describe("the owner's arbiter", () => {
  const fixture = pgTable(
    "conflict_target_fixture",
    {
      id: text().notNull(),
      tenant: text().notNull(),
      state: text({ enum: ["open", "closed"] }).notNull(),
    },
    (table) => [uniqueIndex(ARBITER).on(table.id, table.tenant)],
  );
  const declaration = {
    table: fixture,
    key: "id",
    scope: ["tenant"],
    stateColumn: "state",
    edges: { open: ["closed"], closed: [] },
    initial: ["open"],
  } as const;

  test("names only migrate-built online indexes in its type", () => {
    expectTypeOf<
      typeof CONTACTS_ORG_EXTERNAL_UIDX
    >().toExtend<ConflictTargetIndexName>();
    expectTypeOf<"unregistered_uidx">().not.toExtend<ConflictTargetIndexName>();
  });

  test("refuses an online index its lifecycle holds pending", () => {
    expect(() =>
      defineScopedTransitions(
        {
          ...declaration,
          arbiter: { onlineIndex: CONTACTS_ORG_EXTERNAL_UIDX },
        },
        { lifecycle: { [ARBITER]: PENDING } },
      ),
    ).toThrow(
      `A scoped transition identity rests on pending online work (${ARBITER}); register it DEPLOY_BLOCKING`,
    );
    expect(
      defineScopedTransitions(
        {
          ...declaration,
          arbiter: { onlineIndex: CONTACTS_ORG_EXTERNAL_UIDX },
        },
        { lifecycle: { [ARBITER]: DEPLOY_BLOCKING } },
      ),
    ).toMatchObject({ arbiter: { onlineIndex: ARBITER } });
  });

  test("names online work only as an online index", () => {
    expect(() =>
      defineScopedTransitions(
        { ...declaration, arbiter: { constraint: ARBITER } },
        { lifecycle: { [ARBITER]: DEPLOY_BLOCKING } },
      ),
    ).toThrow(
      `A scoped transition arbiter ${ARBITER} names online work as onlineIndex, and only online work`,
    );
  });
});
