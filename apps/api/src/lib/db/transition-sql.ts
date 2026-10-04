import { panic } from "better-result";
import { getTableName, getColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import type { TransitionSpec } from "@/api/lib/db/transitions";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Called by migrations and real-engine tests; SQL has no separate graph. */
export const transitionTriggerSql = (spec: TransitionSpec): string => {
  const tableName = getTableName(spec.table);
  const columnName = getColumns(spec.table)["status"]?.name;
  if (columnName === undefined) {
    panic("A transition trigger requires a status column");
  }
  const schema = getTableConfig(spec.table).schema;
  const qualify = (name: string) =>
    schema === undefined
      ? identifier(name)
      : `${identifier(schema)}.${identifier(name)}`;
  const table = qualify(tableName);
  const column = identifier(columnName);
  const functionName = qualify(`${tableName}_status_transition_guard`);
  const constraint = `${tableName}_status_transition`;
  const branches = Object.entries(spec.edges).flatMap(([from, targets]) =>
    targets.length === 0
      ? []
      : [
          `(OLD.${column} = ${literal(from)} AND NEW.${column} IN (${targets.map(literal).join(", ")}))`,
        ],
  );
  const allowed =
    branches.length === 0 ? "FALSE" : branches.join("\n      OR ");
  return `CREATE FUNCTION ${functionName}() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.${column} IS NOT DISTINCT FROM NEW.${column}
     AND NEW.${column} IN (${Object.keys(spec.edges).map(literal).join(", ")}) THEN
    RETURN NEW;
  END IF;
  IF NOT COALESCE((
      ${allowed}
  ), FALSE) THEN
    RAISE EXCEPTION 'illegal status transition on ${tableName.replaceAll("'", "''")} from % to %', OLD.${column}, NEW.${column}
      USING ERRCODE = 'check_violation', CONSTRAINT = ${literal(constraint)};
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION ${functionName}() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER ${identifier(constraint)}
BEFORE UPDATE OF ${column} ON ${table}
FOR EACH ROW EXECUTE FUNCTION ${functionName}();
`;
};

export const transitionDomainSql = (spec: TransitionSpec): string => {
  const { name, schema, columns } = getTableConfig(spec.table);
  const status = columns.find(
    (column) => column === getColumns(spec.table)["status"],
  );
  if (status === undefined) {
    panic("A transition domain requires a status column");
  }
  const table =
    schema === undefined
      ? identifier(name)
      : `${identifier(schema)}.${identifier(name)}`;
  return `ALTER TABLE ${table} ADD CONSTRAINT ${identifier(`${name}_status_domain`)} CHECK (${identifier(status.name)} IN (${Object.keys(spec.edges).map(literal).join(", ")})) NOT VALID;\n`;
};
