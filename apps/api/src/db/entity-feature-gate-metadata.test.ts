import { expect, test } from "bun:test";
import { is, sql } from "drizzle-orm";
import {
  getTableConfig,
  PgRole,
  foreignKey,
  PgTable,
  pgPolicy,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { entityFeatureCoverageViolations } from "@/api/db/entity-feature-coverage";
import {
  entityFeatureGateMetadata,
  entityFeatureGateMetadataViolations,
} from "@/api/db/entity-feature-gate-metadata";
import {
  entityFeaturePolicies,
  entityFeaturePolicyStatements,
} from "@/api/db/entity-feature-policies";
import * as schema from "@/api/db/schema";

const scopePolicies = (tableName: string) => {
  const workspaceScope = sql`CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END`;
  const organizationScope = sql`organization_id = (SELECT current_setting('app.organization_id', true))`;
  return [
    pgPolicy(`${tableName}_workspace_select`, {
      for: "select",
      to: "stella",
      using: sql`(${workspaceScope} AND ${organizationScope})`,
    }),
  ];
};

const entityReader = (tableName: string, policy: ReturnType<typeof pgPolicy>) =>
  pgTable(
    tableName,
    {
      id: uuid("id").primaryKey(),
      entityId: uuid("entity_id").references(() => schema.entities.id),
      workspaceId: uuid("workspace_id").notNull(),
    },
    (table) => [
      ...entityFeaturePolicies(
        table,
        new Map([
          [table.entityId, { target: "entities", kind: "owned-content" }],
        ]),
      ),
      policy,
    ],
  );

const unscopedSelectPolicy = (
  tableName: string,
  policyName: string,
  using: ReturnType<typeof sql>,
) =>
  entityReader(
    tableName,
    pgPolicy(policyName, {
      for: "select",
      to: "stella",
      using,
    }),
  );

const readerWithBroadWritePolicy = (
  tableName: string,
  action: "insert" | "update",
  scope: "workspace" | "organization",
) =>
  pgTable(
    tableName,
    {
      id: uuid("id").primaryKey(),
      entityId: uuid("entity_id").references(() => schema.entities.id),
      workspaceId: uuid("workspace_id").notNull(),
      organizationId: uuid("organization_id").notNull(),
    },
    (table) => [
      ...entityFeaturePolicies(
        table,
        new Map([
          [table.entityId, { target: "entities", kind: "owned-content" }],
        ]),
      ),
      ...scopePolicies(tableName),
      ...(scope === "organization"
        ? [
            pgPolicy(`restrictive_workspace_${action}`, {
              as: "restrictive",
              for: action,
              to: "stella",
              using: sql`CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END`,
              withCheck: sql`CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END`,
            }),
          ]
        : []),
      pgPolicy(`broad_${action}`, {
        for: action,
        to: "stella",
        ...(action === "update" ? { using: sql`true` } : {}),
        withCheck: sql`true`,
      }),
    ],
  );

const readerWithComposedBroadUpdateCheck = (
  tableName: string,
  using: "false" | "owner-only",
) =>
  pgTable(
    tableName,
    {
      id: uuid("id").primaryKey(),
      entityId: uuid("entity_id").references(() => schema.entities.id),
      workspaceId: uuid("workspace_id").notNull(),
    },
    (table) => {
      const workspaceScope = sql`CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END`;
      const broadUsing =
        using === "false"
          ? sql`false`
          : sql.raw(
              `current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.${tableName}'::regclass)`,
            );
      return [
        ...entityFeaturePolicies(
          table,
          new Map([
            [table.entityId, { target: "entities", kind: "owned-content" }],
          ]),
        ),
        ...scopePolicies(tableName),
        pgPolicy("workspace_update", {
          for: "update",
          to: "stella",
          using: workspaceScope,
          withCheck: workspaceScope,
        }),
        pgPolicy("broad_update_check", {
          for: "update",
          to: "stella",
          using: broadUsing,
          withCheck: sql`true`,
        }),
      ];
    },
  );

test("a broad permissive policy cannot prove an entity table's own workspace fence", () => {
  const reader = unscopedSelectPolicy(
    "fixture_broad_entity_gate_reader",
    "broad_select",
    sql`(${sql`CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END`} OR true)`,
  );
  const descriptor = entityFeatureGateMetadata([schema.entities, reader]).find(
    ({ tableName }) => tableName === "fixture_broad_entity_gate_reader",
  );

  expect(descriptor?.ownWorkspace).toBe(false);
});

test("a broadened canonical workspace policy fails metadata derivation", () => {
  const reader = unscopedSelectPolicy(
    "fixture_broadened_entity_gate_reader",
    "workspace_select",
    sql`(${sql`CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END`} OR true)`,
  );

  expect(() => entityFeatureGateMetadata([schema.entities, reader])).toThrow(
    "no longer has a canonical workspace scope",
  );
});

for (const action of ["insert", "update"] as const) {
  for (const scope of ["workspace", "organization"] as const) {
    test(`a broad ${action} check cannot inherit a SELECT-only ${scope} proof`, () => {
      const reader = readerWithBroadWritePolicy(
        `fixture_broad_${scope}_${action}_entity_gate_reader`,
        action,
        scope,
      );

      expect(() =>
        entityFeatureGateMetadata([schema.entities, reader]),
      ).toThrow(
        `no longer enforces its canonical ${scope} scope for ${action.toUpperCase()} checks`,
      );
    });
  }
}

for (const using of ["false", "owner-only"] as const) {
  test(`a broad UPDATE check composes with another policy despite ${using} USING`, () => {
    const reader = readerWithComposedBroadUpdateCheck(
      `fixture_broad_update_${using.replaceAll("-", "_")}_entity_gate_reader`,
      using,
    );

    expect(() => entityFeatureGateMetadata([schema.entities, reader])).toThrow(
      "no longer enforces its canonical workspace scope for UPDATE checks",
    );
  });
}

test("a new classified dependent without a gate state fails the metadata census", () => {
  const reader = pgTable(
    "fixture_entity_gate_without_state",
    {
      id: uuid("id").primaryKey(),
      entityId: uuid("entity_id").references(() => schema.entities.id),
      entityFeatureWorkspaceIds: uuid("entity_feature_workspace_ids")
        .array()
        .notNull(),
    },
    (table) =>
      entityFeaturePolicies(
        table,
        new Map([
          [table.entityId, { target: "entities", kind: "owned-content" }],
        ]),
      ),
  );

  expect(
    entityFeatureGateMetadataViolations([schema.entities, reader]),
  ).toEqual(["fixture_entity_gate_without_state requires entity_feature_gate"]);
});

test("a new unpaired relationship without its derived workspace array fails census", () => {
  const reader = pgTable(
    "fixture_entity_gate_without_workspace_array",
    {
      id: uuid("id").primaryKey(),
      entityId: uuid("entity_id").references(() => schema.entities.id),
      entityFeatureGate: text("entity_feature_gate").notNull(),
    },
    (table) =>
      entityFeaturePolicies(
        table,
        new Map([
          [table.entityId, { target: "entities", kind: "owned-content" }],
        ]),
      ),
  );

  expect(
    entityFeatureGateMetadataViolations([schema.entities, reader]),
  ).toEqual([
    "fixture_entity_gate_without_workspace_array requires entity_feature_workspace_ids for its feature gate",
  ]);
});

test("the live entity gate census has scope keys and parent-first ordering", () => {
  const tables = Object.values(schema).filter((table) => is(table, PgTable));
  const descriptors = entityFeatureGateMetadata(tables);
  const positions = new Map(
    descriptors.map(({ tableName }, index) => [tableName, index]),
  );

  expect(entityFeatureGateMetadataViolations(tables)).toEqual([]);
  for (const descriptor of descriptors) {
    for (const reference of descriptor.refs) {
      const parentPosition = positions.get(reference.parent);
      const childPosition = positions.get(descriptor.tableName);
      if (parentPosition !== undefined && childPosition !== undefined) {
        expect(parentPosition).toBeLessThan(childPosition);
      }
    }
  }
});

test("paired direct scope does not erase inherited or unpaired organization requirements", () => {
  const parent = pgTable(
    "fixture_entity_gate_parent",
    {
      id: uuid("id").primaryKey(),
      entityId: uuid("entity_id").references(() => schema.entities.id),
      workspaceId: uuid("workspace_id").notNull(),
      organizationId: uuid("organization_id").notNull(),
      entityFeatureGate: text("entity_feature_gate").notNull(),
      entityFeatureWorkspaceIds: uuid("entity_feature_workspace_ids")
        .array()
        .notNull(),
    },
    (table) => [
      ...entityFeaturePolicies(
        table,
        new Map([
          [table.entityId, { target: "entities", kind: "owned-content" }],
        ]),
      ),
      ...scopePolicies("fixture_entity_gate_parent"),
    ],
  );
  const child = pgTable(
    "fixture_entity_gate_child",
    {
      id: uuid("id").primaryKey(),
      parentId: uuid("parent_id").notNull(),
      workspaceId: uuid("workspace_id").notNull(),
      organizationId: uuid("organization_id").notNull(),
      entityFeatureGate: text("entity_feature_gate").notNull(),
      entityFeatureWorkspaceIds: uuid("entity_feature_workspace_ids")
        .array()
        .notNull(),
      entityFeatureOrganizationIds: text("entity_feature_organization_ids")
        .array()
        .notNull(),
    },
    (table) => [
      foreignKey({
        columns: [table.parentId, table.workspaceId],
        foreignColumns: [parent.id, parent.workspaceId],
      }),
      ...entityFeaturePolicies(
        table,
        new Map([[table.parentId, { kind: "owned-by-parent", parent }]]),
      ),
      ...scopePolicies("fixture_entity_gate_child"),
    ],
  );
  const descriptors = entityFeatureGateMetadata([
    schema.entities,
    parent,
    child,
  ]);
  const parentDescriptor = descriptors.find(
    ({ tableName }) => tableName === "fixture_entity_gate_parent",
  );
  const childDescriptor = descriptors.find(
    ({ tableName }) => tableName === "fixture_entity_gate_child",
  );

  expect(parentDescriptor?.needsWorkspace).toBe(true);
  expect(childDescriptor).toMatchObject({
    ownWorkspace: true,
    ownOrganization: true,
    needsWorkspace: true,
    needsOrganization: true,
    refs: [
      {
        column: "parent_id",
        parent: "fixture_entity_gate_parent",
        hasForeignKey: true,
        sameWorkspace: true,
        sameOrganization: false,
      },
    ],
  });
});

for (const [roleTarget, target] of [
  ["PUBLIC", "public"],
  ["default role", undefined],
] as const) {
  test(`a ${roleTarget} reader of an indirect fenced parent needs classification`, () => {
    const tableName = `fixture_${roleTarget === "PUBLIC" ? "public" : "default"}_indirect_parent_reader`;
    const reader = pgTable(
      tableName,
      {
        id: uuid("id").primaryKey(),
        claimId: uuid("claim_id").references(() => schema.legalListClaims.id),
      },
      () => [
        pgPolicy("indirect_parent_select", {
          for: "select",
          ...(target === undefined ? {} : { to: target }),
          using: sql`true`,
        }),
      ],
    );

    expect(entityFeatureCoverageViolations([reader])).toContain(
      `${tableName}.claim_id requires a classified parent relationship`,
    );
  });
}

test("a newly unpaired entity reference requires the derived workspace key", () => {
  const reader = pgTable(
    "fixture_unpaired_entity_gate_reader",
    {
      id: uuid("id").primaryKey(),
      entityId: uuid("entity_id").references(() => schema.entities.id),
      entityFeatureGate: text("entity_feature_gate").notNull(),
    },
    (table) =>
      entityFeaturePolicies(
        table,
        new Map([
          [table.entityId, { target: "entities", kind: "owned-content" }],
        ]),
      ),
  );
  const tables = [schema.entities, reader];
  const descriptors = entityFeatureGateMetadata(tables);

  expect(
    descriptors.find(
      ({ tableName }) => tableName === "fixture_unpaired_entity_gate_reader",
    ),
  ).toMatchObject({
    needsWorkspace: true,
    refs: [{ column: "entity_id", parent: "entities", hasForeignKey: true }],
  });
  expect(entityFeatureGateMetadataViolations(tables)).toEqual([
    "fixture_unpaired_entity_gate_reader requires entity_feature_workspace_ids for its feature gate",
  ]);
});

test("a classified reference without a foreign key does not prove parent existence", () => {
  const reader = pgTable(
    "fixture_entity_gate_without_foreign_key",
    { entityId: uuid("entity_id") },
    (table) =>
      entityFeaturePolicies(
        table,
        new Map([
          [table.entityId, { target: "entities", kind: "owned-content" }],
        ]),
      ),
  );
  const descriptor = entityFeatureGateMetadata([schema.entities, reader]).find(
    ({ tableName }) => tableName === "fixture_entity_gate_without_foreign_key",
  );

  expect(descriptor?.refs).toEqual([
    {
      column: "entity_id",
      parent: "entities",
      hasForeignKey: false,
      sameWorkspace: false,
      sameOrganization: false,
    },
  ]);
});

test("the migration trigger graph exactly matches the schema-derived census", async () => {
  const migration = await Bun.file(
    new URL(
      "../../drizzle/20261009112500_entity_feature_row_gates/migration.sql",
      import.meta.url,
    ),
  ).text();
  const graphText = migration.match(/\$metadata\$(.+)\$metadata\$/u)?.at(1);
  expect(graphText).toBeDefined();
  const graph: unknown = JSON.parse(graphText ?? "null");
  const tables = Object.values(schema).filter((table) => is(table, PgTable));
  const descriptors = entityFeatureGateMetadata(tables);
  expect(graph).toEqual(
    Object.fromEntries(
      descriptors.map((descriptor, order) => [
        descriptor.tableName,
        expect.objectContaining({ ...descriptor, order }),
      ]),
    ),
  );
});

test("the migration grants maintenance policies only to the dedicated gate role", async () => {
  const migration = await Bun.file(
    new URL(
      "../../drizzle/20261009112500_entity_feature_row_gates/migration.sql",
      import.meta.url,
    ),
  ).text();
  const tables = Object.values(schema).filter((table) => is(table, PgTable));
  const descriptors = entityFeatureGateMetadata(tables);
  const expected = entityFeaturePolicyStatements(
    tables,
    "entity_feature_gate_maintenance",
  );
  const actual =
    migration.match(
      /CREATE POLICY "entity_feature_gate_maintenance"[^;]+;/gu,
    ) ?? [];
  const schemaPolicies = tables.flatMap((table) =>
    getTableConfig(table).policies.filter(
      (policy) => policy.name === "entity_feature_gate_maintenance",
    ),
  );
  const targetsGateRole = (
    target: (typeof schemaPolicies)[number]["to"],
  ): boolean => {
    if (Array.isArray(target)) {
      return target.length === 1 && targetsGateRole(target[0]);
    }
    return (
      target === "stella_entity_gate" ||
      (is(target, PgRole) && target.name === "stella_entity_gate")
    );
  };

  expect(descriptors).toHaveLength(47);
  expect(schemaPolicies).toHaveLength(descriptors.length);
  expect(schemaPolicies.every((policy) => targetsGateRole(policy.to))).toBe(
    true,
  );
  expect(actual).toHaveLength(descriptors.length);
  expect(
    actual
      .map((statement) => statement.replace(/\s+/gu, " ").trim())
      .toSorted(),
  ).toEqual(expected.toSorted());
  expect(
    actual.every((statement) =>
      /AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING \(true\) WITH CHECK \(true\);$/u.test(
        statement.replace(/\s+/gu, " ").trim(),
      ),
    ),
  ).toBe(true);
  expect(migration).not.toMatch(
    /CREATE POLICY "entity_feature_gate_maintenance"[^;]+\bTO\s+(?:PUBLIC|"public")\b/iu,
  );
  for (const signature of [
    "entity_feature_gate_value(text, jsonb)",
    "entity_feature_gate_write()",
    "entity_feature_gate_propagate()",
    "entity_feature_gate_repair_missing()",
    "entity_feature_gate_backfill(text, text, integer)",
  ]) {
    expect(migration).toContain(
      `REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC;`,
    );
  }
});

test("migration maintenance grants match each descriptor's read and write columns", async () => {
  const migration = await Bun.file(
    new URL(
      "../../drizzle/20261009112500_entity_feature_row_gates/migration.sql",
      import.meta.url,
    ),
  ).text();
  const tables = Object.values(schema).filter((table) => is(table, PgTable));
  const descriptors = entityFeatureGateMetadata(tables);
  const grants = [
    ...migration.matchAll(
      /GRANT SELECT \(([^)]+)\), UPDATE \(([^)]+)\) ON public\."([^"]+)" TO stella_entity_gate;/gu,
    ),
  ];
  const actualByTable = new Map(
    grants.map(([, selectColumns, updateColumns, tableName]) => [
      tableName,
      {
        select:
          (selectColumns ?? "")
            .match(/"([^"]+)"/gu)
            ?.map((column) => column.slice(1, -1)) ?? [],
        update:
          (updateColumns ?? "")
            .match(/"([^"]+)"/gu)
            ?.map((column) => column.slice(1, -1)) ?? [],
      },
    ]),
  );

  expect(grants).toHaveLength(descriptors.length);
  expect(actualByTable.size).toBe(descriptors.length);
  for (const descriptor of descriptors) {
    const actual = actualByTable.get(descriptor.tableName);
    expect(actual).toBeDefined();
    const projectedColumns = [
      ...descriptor.projection.matchAll(/'([^']+)', p\."([^"]+)"/gu),
    ].map(([, key, column]) => (key === column ? key : ""));
    expect(projectedColumns.every(Boolean)).toBe(true);
    const expectedSelect = [
      ...new Set([...projectedColumns, ...descriptor.primaryKey]),
    ].toSorted();
    const expectedUpdate = [
      "entity_feature_gate",
      ...(descriptor.needsWorkspace ? ["entity_feature_workspace_ids"] : []),
      ...(descriptor.needsOrganization
        ? ["entity_feature_organization_ids"]
        : []),
    ].toSorted();
    expect(actual?.select.toSorted()).toEqual(expectedSelect);
    expect(actual?.update.toSorted()).toEqual(expectedUpdate);
  }
});
