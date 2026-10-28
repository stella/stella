import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import type { EntityFeatureGateDescriptor } from "../src/db/entity-feature-gate-metadata";
import type { EffectiveEntityFeatureGateDefinitions } from "../src/db/entity-feature-gate-migrations";
import { entityFeaturePolicyDefinitions } from "../src/db/entity-feature-policies";
import { createPolicyStatementsOf } from "../src/tests/helpers/lock-taking-sql";

const breakpoint = "\n--> statement-breakpoint\n";
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

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

/** Additive DDL needed when the schema census contains gates absent from history. */
export const entityFeatureGateTableSql = async (
  tables: readonly PgTable[],
  descriptors: readonly EntityFeatureGateDescriptor[],
  effective: EffectiveEntityFeatureGateDefinitions,
): Promise<string[]> => {
  const missing = descriptors.filter(
    ({ tableName }) =>
      !effective.policies.has(`${tableName}.workspace_entity_feature`),
  );
  const missingNames = new Set(missing.map(({ tableName }) => tableName));
  const statements = missing.flatMap(checkStatements);
  for (const policyName of [
    "workspace_entity_feature",
    "entity_feature_gate_maintenance",
  ]) {
    const policies = entityFeaturePolicyDefinitions(tables, policyName).filter(
      ({ tableName }) => missingNames.has(tableName),
    );
    statements.push(...(await createPolicyStatementsOf(policies)));
  }
  for (const descriptor of missing) {
    statements.push(
      trigger(
        descriptor.tableName,
        "entity_feature_gate_write",
        "BEFORE INSERT OR UPDATE",
      ),
      trigger(
        descriptor.tableName,
        "entity_feature_gate_repair_missing",
        "AFTER INSERT OR UPDATE",
      ),
    );
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
