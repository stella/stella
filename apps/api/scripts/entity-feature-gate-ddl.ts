import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  entityFeatureGateGraphSql,
  entityFeatureGatePropagationSql,
} from "../src/db/entity-feature-gate-metadata";
import type { EntityFeatureGateDescriptor } from "../src/db/entity-feature-gate-metadata";
import type { EffectiveEntityFeatureGateDefinitions } from "../src/db/entity-feature-gate-migrations";
import { entityFeaturePolicyDefinitions } from "../src/db/entity-feature-policies";

const breakpoint = "\n--> statement-breakpoint\n";
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/**
 * A policy's CREATE POLICY statement, spelled as `online-ddl` spells it. The
 * generator writes migration text and must not load the online DDL runner;
 * a test pins this to `online-ddl`'s rendering.
 */
type GatePolicy = ReturnType<typeof entityFeaturePolicyDefinitions>[number];

export const createPolicyStatement = ({
  tableName,
  name,
  as,
  for: command,
  role,
  using,
  withCheck,
}: GatePolicy): string =>
  `CREATE POLICY ${quote(name)} ON "public".${quote(tableName)} AS ${as.toUpperCase()} FOR ${command.toUpperCase()} TO ${quote(role)}${
    using === undefined ? "" : ` USING (${using})`
  }${withCheck === undefined ? "" : ` WITH CHECK (${withCheck})`};`;

const checkStatements = ({ tableName }: EntityFeatureGateDescriptor) => [
  `DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.${tableName}'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public.${quote(tableName)} ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;`,
  `DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.${tableName}'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public.${quote(tableName)} ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;`,
];

const trigger = (table: string, name: string, body: string) => {
  const row =
    name === "entity_feature_gate_write" ||
    name === "entity_feature_gate_repair_missing";
  const routine = row ? name : "entity_feature_gate_propagate";
  const condition =
    name === "entity_feature_gate_repair_missing"
      ? "WHEN (NEW.entity_feature_gate = 'missing') "
      : "";
  const referencingAt = body.indexOf(" REFERENCING ");
  const event = referencingAt === -1 ? body : body.slice(0, referencingAt);
  const transitionRelations =
    referencingAt === -1
      ? undefined
      : body.slice(referencingAt + " REFERENCING ".length);
  return `CREATE TRIGGER ${name} ${event} ON public.${quote(table)}${transitionRelations === undefined ? "" : ` REFERENCING ${transitionRelations}`} FOR EACH ${row ? "ROW" : "STATEMENT"} ${condition}EXECUTE FUNCTION public.${routine}();`;
};

const propagationTriggers = (table: string) => [
  trigger(
    table,
    "entity_feature_gate_insert",
    "AFTER INSERT REFERENCING NEW TABLE AS entity_feature_new_rows",
  ),
  trigger(
    table,
    "entity_feature_gate_update",
    "AFTER UPDATE REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows",
  ),
  trigger(
    table,
    "entity_feature_gate_delete",
    "AFTER DELETE REFERENCING OLD TABLE AS entity_feature_old_rows",
  ),
];

/**
 * Routines the gate role owns: the gate migration created them under
 * `SET LOCAL ROLE stella_entity_gate`, and only an owner may replace a
 * routine or change its privileges.
 */
const GATE_ROLE_ROUTINES: ReadonlySet<string> = new Set([
  "entity_feature_gate_value",
  "entity_feature_gate_write",
  "entity_feature_gate_propagate",
  "entity_feature_gate_repair_missing",
  "entity_feature_gate_backfill",
]);

/** A routine's replacement statements, run as the role that owns it. */
export const routineReplacementSql = (
  name: string,
  statements: readonly string[],
): string[] =>
  GATE_ROLE_ROUTINES.has(name)
    ? ["SET LOCAL ROLE stella_entity_gate;", ...statements, "RESET ROLE;"]
    : [...statements];

/** The routines derived from the census, by name. */
export const entityFeatureGateRoutines = (
  descriptors: readonly EntityFeatureGateDescriptor[],
) =>
  [
    ["entity_feature_gate_graph", entityFeatureGateGraphSql(descriptors)],
    [
      "entity_feature_gate_propagate",
      entityFeatureGatePropagationSql(descriptors),
    ],
  ] as const;

/** Additive DDL needed when the schema census contains gates absent from history. */
export const entityFeatureGateTableSql = (
  tables: readonly PgTable[],
  descriptors: readonly EntityFeatureGateDescriptor[],
  effective: EffectiveEntityFeatureGateDefinitions,
): string[] => {
  const statements = entityFeatureGateRoutines(descriptors).flatMap(
    ([name, sql]) => {
      if (effective.functions.get(name) === sql) {
        return [];
      }
      const signature = `${name}()`;
      return routineReplacementSql(name, [
        sql,
        ...(effective.revokes.has(signature)
          ? []
          : [`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC;`]),
      ]);
    },
  );
  // Each piece is checked on its own: a table's schema migration may already
  // have created its visibility policy (`entityFeaturePolicies` declares it)
  // without the gate triggers or the gate role's grants.
  const has = (table: string, name: string) =>
    effective.policies.has(`${table}.${name}`);
  const hasTrigger = (table: string, name: string) =>
    effective.triggers.has(`${table}.${name}`);
  const missing = descriptors.filter(
    ({ tableName, refs }) =>
      !has(tableName, "workspace_entity_feature") ||
      !has(tableName, "entity_feature_gate_maintenance") ||
      !hasTrigger(tableName, "entity_feature_gate_write") ||
      (refs.length > 0 &&
        !hasTrigger(tableName, "entity_feature_gate_repair_missing")) ||
      !effective.grants.has(tableName),
  );
  const missingNames = new Set(missing.map(({ tableName }) => tableName));
  // The checks are idempotent DO blocks, so a table missing any piece gets them.
  statements.push(...missing.flatMap(checkStatements));
  for (const policyName of [
    "workspace_entity_feature",
    "entity_feature_gate_maintenance",
  ]) {
    const policies = entityFeaturePolicyDefinitions(tables, policyName).filter(
      ({ tableName }) =>
        missingNames.has(tableName) && !has(tableName, policyName),
    );
    statements.push(...policies.map(createPolicyStatement));
  }
  for (const descriptor of missing) {
    for (const [name, timing] of [
      ["entity_feature_gate_write", "BEFORE INSERT OR UPDATE"],
      ["entity_feature_gate_repair_missing", "AFTER INSERT OR UPDATE"],
    ] as const) {
      if (
        !hasTrigger(descriptor.tableName, name) &&
        (name !== "entity_feature_gate_repair_missing" ||
          descriptor.refs.length > 0)
      ) {
        statements.push(trigger(descriptor.tableName, name, timing));
      }
    }
    if (effective.grants.has(descriptor.tableName)) {
      continue;
    }
    const selected = [
      ...new Set([
        ...[...descriptor.projection.matchAll(/'([^']+)', p\."([^"]+)"/gu)].map(
          (match) => match[2] ?? "",
        ),
        ...descriptor.primaryKey,
      ]),
    ];
    const updated = [
      "entity_feature_gate",
      ...(descriptor.needsWorkspace ? ["entity_feature_workspace_ids"] : []),
      ...(descriptor.needsOrganization
        ? ["entity_feature_organization_ids"]
        : []),
    ];
    statements.push(
      `GRANT SELECT (${selected.map(quote).join(", ")}), UPDATE (${updated.map(quote).join(", ")}) ON public.${quote(descriptor.tableName)} TO stella_entity_gate;`,
    );
  }
  const parents = new Set(
    descriptors.flatMap(({ refs }) => refs.map(({ parent }) => parent)),
  );
  for (const parent of parents) {
    for (const statement of propagationTriggers(parent)) {
      const name = /CREATE TRIGGER ([a-z_]+)/u.exec(statement)?.[1] ?? "";
      if (!effective.triggers.has(`${parent}.${name}`)) {
        statements.push(statement);
      }
    }
  }
  for (const table of tables) {
    const config = getTableConfig(table);
    if (!missingNames.has(config.name)) {
      continue;
    }
    for (const index of config.indexes) {
      const { name, columns, unique, method } = index.config;
      if (
        name === undefined ||
        !name.includes("_ef_") ||
        effective.indexes.has(`${config.name}.${name}`)
      ) {
        continue;
      }
      const columnNames = columns.flatMap((column) =>
        "name" in column ? [quote(column.name)] : [],
      );
      statements.push(
        `COMMIT;${breakpoint}DROP INDEX CONCURRENTLY IF EXISTS public.${quote(name)};${breakpoint}CREATE ${unique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${quote(name)} ON public.${quote(config.name)}${method && method !== "btree" ? ` USING ${method}` : ""} (${columnNames.join(", ")});${breakpoint}BEGIN;`,
      );
    }
  }
  return statements;
};
