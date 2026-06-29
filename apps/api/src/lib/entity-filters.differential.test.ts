import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api-postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import type { ConditionNode } from "@stll/conditions";
import { propertyConfig } from "@stll/property-testing";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import { entities, entityVersions, fields, properties } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import { applyFilters, buildFilterConditions } from "@/api/lib/entity-filters";

// ── Differential property test ──────────────────────────────
//
// Stella evaluates view-filter conditions twice: in memory via
// `applyFilters` (the `@stll/conditions` evaluator) and in SQL via
// `buildFilterConditions` (a WHERE clause). This test generates random
// rows + a random condition, runs both paths against the same data, and
// asserts the matching entity-id sets are identical. Any disagreement is
// a real bug in one of the two implementations (or a by-design divergence
// that is deliberately excluded from the generator below, with a reason).

const allSchema = { ...schema, ...authSchema, ...rlsExports };

type RawDb = ReturnType<typeof drizzle>;

let client: PGlite;
let db: RawDb;

const ORG_ID = toSafeId<"organization">(Bun.randomUUIDv7());
const WS_ID = toSafeId<"workspace">(Bun.randomUUIDv7());
const CONTACT_ID = toSafeId<"contact">(Bun.randomUUIDv7());

// ── Fixed property catalogue ────────────────────────────────
//
// One property per supported value type. Select properties carry a small
// fixed option set so generated values land both inside and outside it.

const SELECT_OPTIONS = ["alpha", "beta", "gamma"] as const;
type SelectOption = (typeof SELECT_OPTIONS)[number];

const PROP = {
  text: toSafeId<"property">(Bun.randomUUIDv7()),
  single: toSafeId<"property">(Bun.randomUUIDv7()),
  multi: toSafeId<"property">(Bun.randomUUIDv7()),
  int: toSafeId<"property">(Bun.randomUUIDv7()),
  date: toSafeId<"property">(Bun.randomUUIDv7()),
} as const;

type PropKey = keyof typeof PROP;
const PROP_KEYS: readonly PropKey[] = [
  "text",
  "single",
  "multi",
  "int",
  "date",
];

const PROP_TOOL = { version: 1 as const, type: "manual-input" as const };

const propertyContent = (key: PropKey) => {
  if (key === "text") {
    return { version: 1 as const, type: "text" as const };
  }
  if (key === "int") {
    return { version: 1 as const, type: "int" as const };
  }
  if (key === "date") {
    return { version: 1 as const, type: "date" as const };
  }
  return {
    version: 1 as const,
    type:
      key === "single" ? ("single-select" as const) : ("multi-select" as const),
    options: SELECT_OPTIONS.map((value) => ({ color: "gray", value })),
    fallback: null,
  };
};

const ENTITY_KINDS: readonly EntityKind[] = [
  "document",
  "task",
  "message",
  "link",
];

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client });
  const pushDb = drizzle({ client });

  await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
  await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));

  const { sqlStatements } = await pushSchema(allSchema, pushDb);
  // Schema DDL must apply in dependency order, so these run sequentially.
  for (const statement of sqlStatements) {
    // eslint-disable-next-line no-await-in-loop -- ordered DDL, can't parallelize
    await db.execute(sql.raw(statement));
  }

  await db.insert(authSchema.user).values({
    id: "user_diff_test",
    name: "Diff",
    email: "diff@test.local",
  });
  await db.insert(authSchema.organization).values({
    id: ORG_ID,
    name: "Diff Org",
    slug: "diff-org",
    createdAt: new Date(),
  });
  await db.insert(schema.contacts).values({
    id: CONTACT_ID,
    organizationId: ORG_ID,
    type: "person",
    displayName: "Diff Contact",
  });
  await db.insert(schema.workspaces).values({
    id: WS_ID,
    organizationId: ORG_ID,
    clientId: CONTACT_ID,
    name: "Diff WS",
    reference: "REF-DIFF",
    status: "active",
  });

  await db.insert(properties).values(
    PROP_KEYS.map((key) => ({
      id: PROP[key],
      workspaceId: WS_ID,
      name: key,
      content: propertyContent(key),
      tool: PROP_TOOL,
      status: "fresh" as const,
    })),
  );
});

afterAll(async () => {
  await client.close();
});

// ── Generated row model ─────────────────────────────────────

type FilterableEntity = {
  entityId: string;
  kind: EntityKind;
  fields: {
    id: string;
    propertyId: string;
    entityId: string;
    content: FieldContent;
  }[];
};

type GeneratedRow = {
  kind: EntityKind;
  // A field per property, or null for "field absent".
  values: Record<PropKey, FieldContent | null>;
};

// Safe text alphabet: lowercase letters only. Excludes SQL LIKE
// metacharacters (`%`, `_`) — `contains`/`starts_with`/`ends_with` map to
// ILIKE patterns in SQL but plain substring checks in memory, so a literal
// `%` would legitimately diverge (a surface-syntax escaping concern, not a
// filter-semantics bug).
const safeText = fc.stringMatching(/^[a-z]{1,6}$/u);

const fieldContentArb = (key: PropKey): fc.Arbitrary<FieldContent> => {
  if (key === "text") {
    return safeText.map((value) => ({ version: 1, type: "text", value }));
  }
  if (key === "int") {
    return fc
      .integer({ min: -20, max: 20 })
      .map((value) => ({ version: 1, type: "int", value, currency: null }));
  }
  if (key === "date") {
    return fc
      .date({
        min: new Date("2020-01-01T00:00:00Z"),
        max: new Date("2026-12-31T00:00:00Z"),
        noInvalidDate: true,
      })
      .map((d) => ({
        version: 1,
        type: "date",
        value: d.toISOString().slice(0, 10),
      }));
  }
  // single-select / multi-select draw from options plus an extra value that
  // is not a current option (legacy/stale data).
  const optionPool: SelectOption[] = [...SELECT_OPTIONS];
  if (key === "single") {
    return fc
      .constantFrom<SelectOption | null>(...optionPool, null)
      .map((value) => ({ version: 1, type: "single-select", value }));
  }
  return fc
    .uniqueArray(fc.constantFrom<SelectOption>(...optionPool), {
      minLength: 0,
      maxLength: 3,
    })
    .map((value) => ({ version: 1, type: "multi-select", value }));
};

const rowArb: fc.Arbitrary<GeneratedRow> = fc.record({
  kind: fc.constantFrom<EntityKind>(...ENTITY_KINDS),
  values: fc.record({
    text: fc.option(fieldContentArb("text"), { nil: null }),
    single: fc.option(fieldContentArb("single"), { nil: null }),
    multi: fc.option(fieldContentArb("multi"), { nil: null }),
    int: fc.option(fieldContentArb("int"), { nil: null }),
    date: fc.option(fieldContentArb("date"), { nil: null }),
  }),
});

const rowsArb = fc.array(rowArb, { minLength: 1, maxLength: 8 });

// ── Generated condition model ───────────────────────────────
//
// Operands are restricted to `property` (the inserted ones) and `kind`.
// `builtin` and `path` operands are excluded: the in-memory evaluator
// treats them as server-side pass-through by design, so they legitimately
// diverge from SQL and are not in scope for this differential test.
//
// Each property only pairs with the operators the filter builder actually
// offers for its value type (`OPERATORS_BY_VALUE_TYPE` in the web
// condition-builder). Generating operator/type pairs the UI can never produce
// (e.g. `gt` on a multi-select, `in` on text) would compare two
// implementations on inputs neither is designed to handle, surfacing
// divergences that no real filter can hit.

const propertyOperand = (key: PropKey) => ({
  type: "property" as const,
  propertyId: PROP[key],
});

const dateLiteral = fc
  .date({
    min: new Date("2020-01-01T00:00:00Z"),
    max: new Date("2026-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));

// Scalar literal pools per value type, drawn so generated filters land both
// on and off the row values inserted for that property.
const scalarLiteralArb = (key: PropKey): fc.Arbitrary<string> => {
  if (key === "int") {
    return fc.integer({ min: -20, max: 20 }).map(String);
  }
  if (key === "date") {
    return dateLiteral;
  }
  if (key === "single") {
    return fc.constantFrom<string>(...SELECT_OPTIONS, "stale");
  }
  return safeText;
};

// Sometimes emit an empty value/payload: an incomplete filter (operator chosen,
// value not entered). Both paths must treat it as a no-op, so it's in scope.
const maybeEmpty = (arb: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc.oneof(
    { weight: 1, arbitrary: fc.constant("") },
    { weight: 4, arbitrary: arb },
  );

const singleSelectInPayload = fc.uniqueArray(
  fc.constantFrom<string>(...SELECT_OPTIONS, "stale"),
  { minLength: 0, maxLength: 3 },
);

const compareLeaf = (
  key: PropKey,
  ops: readonly ("eq" | "neq" | "gt" | "lt" | "gte" | "lte")[],
): fc.Arbitrary<ConditionNode> =>
  fc
    .record({
      op: fc.constantFrom(...ops),
      value: maybeEmpty(scalarLiteralArb(key)),
    })
    .map(({ op, value }) => ({
      type: "compare",
      left: propertyOperand(key),
      op,
      right: { type: "literal", value },
    }));

const emptinessLeaf = (key: PropKey): fc.Arbitrary<ConditionNode> =>
  fc
    .constantFrom("is_empty", "is_not_empty")
    .map((op) => ({ type: "predicate", operand: propertyOperand(key), op }));

const textPredicateLeaf = (
  key: PropKey,
  ops: readonly ("contains" | "not_contains" | "starts_with" | "ends_with")[],
): fc.Arbitrary<ConditionNode> =>
  fc
    .record({
      op: fc.constantFrom(...ops),
      value: maybeEmpty(scalarLiteralArb(key)),
    })
    .map(({ op, value }) => ({
      type: "predicate",
      operand: propertyOperand(key),
      op,
      value,
    }));

// Per value type, mirroring OPERATORS_BY_VALUE_TYPE in the web builder.
const textLeaf = fc.oneof(
  compareLeaf("text", ["eq", "neq"]),
  textPredicateLeaf("text", [
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
  ]),
  emptinessLeaf("text"),
);

const singleSelectLeaf = fc.oneof(
  compareLeaf("single", ["eq", "neq"]),
  singleSelectInPayload.map((value) => ({
    type: "predicate" as const,
    operand: propertyOperand("single"),
    op: "in" as const,
    value,
  })),
  emptinessLeaf("single"),
);

// multi-select offers only membership predicates (contains/not_contains) plus
// emptiness — no compare ops and no `in`/`contains_all`.
const multiSelectLeaf = fc.oneof(
  textPredicateLeaf("multi", ["contains", "not_contains"]),
  emptinessLeaf("multi"),
);

const numericLeaf = (key: "int" | "date") =>
  fc.oneof(
    compareLeaf(key, ["eq", "neq", "gt", "lt", "gte", "lte"]),
    emptinessLeaf(key),
  );

const kindLeaf: fc.Arbitrary<ConditionNode> = fc
  // Empty kind `in` is an incomplete filter — both paths no-op it (SQL drops it,
  // the evaluator returns vacuously true), so it is in scope here.
  .uniqueArray(fc.constantFrom<EntityKind>(...ENTITY_KINDS), {
    minLength: 0,
    maxLength: 4,
  })
  .map((value) => ({
    type: "predicate",
    operand: { type: "kind" },
    op: "in",
    value,
  }));

const leafArb: fc.Arbitrary<ConditionNode> = fc.oneof(
  textLeaf,
  singleSelectLeaf,
  multiSelectLeaf,
  numericLeaf("int"),
  numericLeaf("date"),
  kindLeaf,
);

const { node: conditionArb } = fc.letrec<{
  node: ConditionNode;
  group: ConditionNode;
}>((tie) => ({
  node: fc.oneof({ maxDepth: 3, withCrossShrink: true }, leafArb, tie("group")),
  group: fc
    .record({
      combinator: fc.constantFrom("and", "or"),
      negated: fc.boolean(),
      children: fc.array(tie("node"), { minLength: 1, maxLength: 3 }),
    })
    .map(({ combinator, negated, children }) => ({
      type: "group",
      combinator,
      negated,
      children,
    })),
}));

// ── Both evaluation paths ───────────────────────────────────

const toFilterableEntities = (
  rows: GeneratedRow[],
  ids: string[],
): FilterableEntity[] =>
  rows.map((row, index) => {
    const entityId = ids[index] ?? "";
    const entityFields: FilterableEntity["fields"] = [];
    for (const key of PROP_KEYS) {
      const content = row.values[key];
      if (content !== null) {
        entityFields.push({
          id: `field_${key}_${entityId}`,
          propertyId: PROP[key],
          entityId,
          content,
        });
      }
    }
    return { entityId, kind: row.kind, fields: entityFields };
  });

const seedRows = async (rows: GeneratedRow[]): Promise<string[]> => {
  const ids = rows.map(() => toSafeId<"entity">(Bun.randomUUIDv7()));
  const versionIds = rows.map(() =>
    toSafeId<"entityVersion">(Bun.randomUUIDv7()),
  );

  await db.insert(entities).values(
    rows.map((row, index) => ({
      id: ids[index] ?? toSafeId<"entity">(""),
      workspaceId: WS_ID,
      kind: row.kind,
      name: `entity_${index}`,
    })),
  );
  await db.insert(entityVersions).values(
    rows.map((_, index) => ({
      id: versionIds[index] ?? toSafeId<"entityVersion">(""),
      workspaceId: WS_ID,
      entityId: ids[index] ?? toSafeId<"entity">(""),
    })),
  );
  // Independent per-entity updates (FK requires the version to exist first).
  await Promise.all(
    ids.map((entityId, index) =>
      db
        .update(entities)
        .set({ currentVersionId: versionIds[index] ?? null })
        .where(eq(entities.id, entityId)),
    ),
  );

  const fieldRows = rows.flatMap((row, index) =>
    PROP_KEYS.flatMap((key) => {
      const content = row.values[key];
      if (content === null) {
        return [];
      }
      return [
        {
          id: toSafeId<"field">(Bun.randomUUIDv7()),
          workspaceId: WS_ID,
          propertyId: PROP[key],
          entityVersionId: versionIds[index] ?? toSafeId<"entityVersion">(""),
          content,
        },
      ];
    }),
  );
  if (fieldRows.length > 0) {
    await db.insert(fields).values(fieldRows);
  }

  return ids;
};

const clearRows = async () => {
  await db.delete(fields).where(eq(fields.workspaceId, WS_ID));
  await db
    .update(entities)
    .set({ currentVersionId: null })
    .where(eq(entities.workspaceId, WS_ID));
  await db.delete(entityVersions).where(eq(entityVersions.workspaceId, WS_ID));
  await db.delete(entities).where(eq(entities.workspaceId, WS_ID));
};

const sqlMatchIds = async (condition: ConditionNode): Promise<Set<string>> => {
  const conditions = buildFilterConditions([condition]);
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.workspaceId, WS_ID), ...conditions));
  return new Set(rows.map((r) => r.id));
};

test(
  "in-memory and SQL filter evaluation agree",
  async () => {
    await fc.assert(
      fc.asyncProperty(rowsArb, conditionArb, async (rows, condition) => {
        const ids = await seedRows(rows);
        try {
          const sqlIds = await sqlMatchIds(condition);
          const memoryEntities = toFilterableEntities(rows, ids);
          const memoryIds = new Set(
            applyFilters(memoryEntities, [condition]).map((e) => e.entityId),
          );
          expect([...sqlIds].toSorted()).toEqual([...memoryIds].toSorted());
        } finally {
          await clearRows();
        }
      }),
      propertyConfig({ numRuns: 300 }),
    );
  },
  { timeout: 60_000 },
);
