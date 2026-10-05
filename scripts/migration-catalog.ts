#!/usr/bin/env bun

import { panic } from "better-result";
import { SQL } from "bun";

import { compareCodeUnit } from "@stll/collation";

import { REHEARSAL_ROWS_PER_DECISION } from "../apps/api/src/scripts/seed-migration-rehearsal-plan";

type Row = Record<string, unknown>;
type Catalog = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const SEEDED_TABLES = new Set([
  ...Object.keys(REHEARSAL_ROWS_PER_DECISION),
  "case_law_sources",
  "corpus_index_generations",
  "oauth_client",
]);
const VOLATILE_DEFAULT =
  /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp|gen_random_uuid|uuid_generate_v4|nextval)\s*\(/iu;
const USER_SCHEMA = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";

/** A volatile default produces different values in the two disposable databases. */
export const digestColumnNames = (
  columns: readonly { name: string; default: string | null }[],
): string[] =>
  columns
    .filter(({ default: expression }) =>
      expression === null ? true : !VOLATILE_DEFAULT.test(expression),
    )
    .map(({ name }) => name)
    .toSorted();

export const ledgerPairs = (
  rows: readonly { name: string; hash: string }[],
): string[] =>
  [
    ...new Set(rows.map(({ name, hash }) => JSON.stringify([name, hash]))),
  ].toSorted();

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => compareCodeUnit(left, right))
        .map(([key, nested]) => [
          key,
          Array.isArray(nested) && ["acl", "config", "roles"].includes(key)
            ? nested.toSorted((left, right) =>
                compareCodeUnit(String(left), String(right)),
              )
            : stable(nested),
        ]),
    );
  }
  return value;
};

/** Report the first observable difference; object insertion and row order do not matter. */
export const compareCatalogs = (
  left: Catalog,
  right: Catalog,
  excludedDataTables: ReadonlySet<string> = new Set(),
): string[] => {
  const differences: string[] = [];
  const visit = (a: unknown, b: unknown, path: string): void => {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        differences.push(`${path}.length: ${a.length} != ${b.length}`);
      }
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        visit(a[index], b[index], `${path}[${index}]`);
      }
      return;
    }
    if (isRecord(a) && isRecord(b)) {
      for (const key of new Set(
        [...Object.keys(a), ...Object.keys(b)].toSorted(),
      )) {
        if (path === "data" && excludedDataTables.has(key)) {
          continue;
        }
        visit(a[key], b[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (a !== b) {
      differences.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    }
  };
  visit(stable(left), stable(right), "");
  return differences;
};

/** Tables changed by the base checkout's seed, including trigger and function effects. */
export const seedFootprint = (before: Catalog, after: Catalog): string[] => {
  const beforeData = before["data"];
  const afterData = after["data"];
  if (!isRecord(beforeData) || !isRecord(afterData)) {
    panic("Both snapshots must contain data digests");
  }
  return [...new Set([...Object.keys(beforeData), ...Object.keys(afterData)])]
    .filter((table) => beforeData[table] !== afterData[table])
    .toSorted();
};

export const rowsByKey = (
  rows: readonly Row[],
  fields: readonly string[],
): Record<string, Row> =>
  Object.fromEntries(
    rows.map((row) => [
      fields.map((field) => String(row[field])).join("."),
      row,
    ]),
  );

const queryRows = async (client: SQL, query: string): Promise<Row[]> =>
  await client.unsafe(query);

const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

const snapshotData = async (
  client: SQL,
  tables: readonly Row[],
  columns: readonly Row[],
): Promise<Record<string, string>> => {
  const data: Record<string, string> = {};
  for (const table of tables) {
    const schema = String(table["schema"]);
    const name = String(table["name"]);
    if (
      schema === "drizzle" ||
      (schema === "public" && SEEDED_TABLES.has(name)) ||
      table["kind"] === "f"
    ) {
      continue;
    }
    const selected = digestColumnNames(
      columns
        .filter(
          (column) => column["schema"] === schema && column["table"] === name,
        )
        .map((column) => {
          const expression = column["default"];
          if (expression !== null && typeof expression !== "string") {
            panic("Catalog column default must be text or null");
          }
          return { name: String(column["name"]), default: expression };
        }),
    );
    const excluded = columns
      .filter(
        (column) =>
          column["schema"] === schema &&
          column["table"] === name &&
          !selected.includes(String(column["name"])),
      )
      .map((column) => String(column["name"]));
    const expression =
      excluded.length === 0
        ? "to_jsonb(t)"
        : `to_jsonb(t) - ARRAY[${excluded.map((column) => `'${column.replaceAll("'", "''")}'`).join(", ")}]::text[]`;
    const digest = await queryRows(
      client,
      `
      SELECT count(*)::text AS count,
             md5(coalesce(string_agg(row_hash, ',' ORDER BY row_hash), '')) AS digest
      FROM (SELECT md5((${expression})::text) AS row_hash
            FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)} t) rows`,
    );
    data[`${schema}.${name}`] =
      `${String(digest.at(0)?.["count"])}:${String(digest.at(0)?.["digest"])}`;
  }
  return data;
};

/** Catalog only non-system objects. Database-local names are stable across both paths. */
export const snapshotCatalog = async (client: SQL): Promise<Catalog> => {
  const schemas = await queryRows(
    client,
    `
    SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
           coalesce(n.nspacl::text[], '{}'::text[]) AS acl
    FROM pg_namespace n WHERE ${USER_SCHEMA} ORDER BY n.nspname`,
  );
  const extensions = await queryRows(
    client,
    `
    SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version,
           pg_get_userbyid(e.extowner) AS owner
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY e.extname`,
  );
  const tables = await queryRows(
    client,
    `
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
           c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
           pg_get_userbyid(c.relowner) AS owner,
           coalesce(c.relacl::text[], '{}'::text[]) AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'f')
    ORDER BY n.nspname, c.relname`,
  );
  const columns = await queryRows(
    client,
    `
    SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity AS identity,
           a.attgenerated AS generated,
           coalesce(a.attacl::text[], '{}'::text[]) AS acl
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY n.nspname, c.relname, a.attname`,
  );
  const constraints = await queryRows(
    client,
    `
    SELECT n.nspname AS schema, c.relname AS "table", con.conname AS name,
           pg_get_constraintdef(con.oid, true) AS definition,
           con.convalidated AS valid
    FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
    LEFT JOIN pg_class c ON c.oid = con.conrelid
    WHERE ${USER_SCHEMA} ORDER BY n.nspname, c.relname, con.conname`,
  );
  const indexes = await queryRows(
    client,
    `
    SELECT n.nspname AS schema, t.relname AS "table", i.relname AS name,
           pg_get_indexdef(i.oid) AS definition, x.indisvalid AS valid,
           x.indisready AS ready
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE ${USER_SCHEMA} ORDER BY n.nspname, t.relname, i.relname`,
  );
  const policies = await queryRows(
    client,
    `
    SELECT schemaname AS schema, tablename AS "table", policyname AS name,
           permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema'
    ORDER BY schemaname, tablename, policyname`,
  );
  const functions = await queryRows(
    client,
    `
    SELECT n.nspname AS schema, p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS arguments,
           md5(pg_get_functiondef(p.oid)) AS definition_md5,
           pg_get_userbyid(p.proowner) AS owner,
           p.prosecdef AS security_definer, p.proconfig AS config,
           coalesce(p.proacl::text[], '{}'::text[]) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE ${USER_SCHEMA} ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)`,
  );
  const triggers = await queryRows(
    client,
    `
    SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS name,
           pg_get_triggerdef(t.oid, true) AS definition, t.tgenabled AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${USER_SCHEMA} AND NOT t.tgisinternal
    ORDER BY n.nspname, c.relname, t.tgname`,
  );
  const views = await queryRows(
    client,
    `
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
           pg_get_viewdef(c.oid, true) AS definition,
           pg_get_userbyid(c.relowner) AS owner,
           coalesce(c.relacl::text[], '{}'::text[]) AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${USER_SCHEMA} AND c.relkind IN ('v', 'm')
    ORDER BY n.nspname, c.relname`,
  );
  const sequences = await queryRows(
    client,
    `
    SELECT n.nspname AS schema, c.relname AS name, s.seqtypid::regtype::text AS type,
           s.seqstart AS start, s.seqincrement AS increment, s.seqmin AS minimum,
           s.seqmax AS maximum, s.seqcache AS cache, s.seqcycle AS cycle,
           pg_get_userbyid(c.relowner) AS owner,
           coalesce(c.relacl::text[], '{}'::text[]) AS acl
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${USER_SCHEMA} ORDER BY n.nspname, c.relname`,
  );
  const enumRows = await queryRows(
    client,
    `
    SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS label
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE ${USER_SCHEMA} ORDER BY n.nspname, t.typname, e.enumsortorder`,
  );
  const types = await queryRows(
    client,
    `SELECT n.nspname AS schema, t.typname AS name, t.typtype AS kind,
            pg_get_userbyid(t.typowner) AS owner,
            coalesce(t.typacl::text[], '{}'::text[]) AS acl
     FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE ${USER_SCHEMA} AND t.typtype IN ('c', 'd', 'e', 'r', 'm')
     ORDER BY n.nspname, t.typname`,
  );
  const defaultAcls = await queryRows(
    client,
    `SELECT coalesce(n.nspname, '') AS schema, r.rolname AS owner,
            d.defaclobjtype AS kind, coalesce(d.defaclacl::text[], '{}'::text[]) AS acl
     FROM pg_default_acl d JOIN pg_roles r ON r.oid = d.defaclrole
     LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.oid IS NULL OR (${USER_SCHEMA})
     ORDER BY n.nspname, r.rolname, d.defaclobjtype`,
  );
  const memberships = await queryRows(
    client,
    `
    SELECT member.rolname AS member, role.rolname AS role,
           grantor.rolname AS grantor, m.admin_option AS admin,
           m.inherit_option AS inherit, m.set_option AS can_set
    FROM pg_auth_members m JOIN pg_roles member ON member.oid = m.member
    JOIN pg_roles role ON role.oid = m.roleid
    JOIN pg_roles grantor ON grantor.oid = m.grantor
    WHERE member.rolname LIKE 'stella%' OR role.rolname LIKE 'stella%'
    ORDER BY member.rolname, role.rolname, grantor.rolname`,
  );
  const ledgerRows = await queryRows(
    client,
    `
    SELECT name, hash FROM drizzle.__drizzle_migrations ORDER BY name, hash`,
  );

  const data = await snapshotData(client, tables, columns);

  const enums: Record<string, string[]> = {};
  for (const row of enumRows) {
    const key = `${String(row["schema"])}.${String(row["name"])}`;
    (enums[key] ??= []).push(String(row["label"]));
  }
  return {
    schemas: rowsByKey(schemas, ["name"]),
    extensions: rowsByKey(extensions, ["name"]),
    tables: rowsByKey(tables, ["schema", "name"]),
    columns: rowsByKey(columns, ["schema", "table", "name"]),
    constraints: rowsByKey(constraints, ["schema", "table", "name"]),
    indexes: rowsByKey(indexes, ["schema", "table", "name"]),
    policies: rowsByKey(policies, ["schema", "table", "name"]),
    functions: rowsByKey(functions, ["schema", "name", "arguments"]),
    triggers: rowsByKey(triggers, ["schema", "table", "name"]),
    views: rowsByKey(views, ["schema", "name"]),
    sequences: rowsByKey(sequences, ["schema", "name"]),
    types: rowsByKey(types, ["schema", "name"]),
    defaultAcls: rowsByKey(defaultAcls, ["schema", "owner", "kind"]),
    enums,
    memberships,
    ledger: ledgerPairs(
      ledgerRows.map((row) => ({
        name: String(row["name"]),
        hash: String(row["hash"]),
      })),
    ),
    data,
  };
};

if (import.meta.main) {
  const [command, first, second, third, fourth] = process.argv.slice(2);
  if (command === "snapshot" && first === undefined && second === undefined) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      panic("DATABASE_URL is required");
    }
    const client = new SQL({ url, max: 1, connectionTimeout: 30 });
    try {
      console.log(JSON.stringify(await snapshotCatalog(client)));
    } finally {
      await client.end();
    }
  } else if (
    command === "seed-footprint" &&
    first &&
    second &&
    third === undefined
  ) {
    console.log(
      seedFootprint(
        await Bun.file(first).json(),
        await Bun.file(second).json(),
      ).join("\n"),
    );
  } else if (
    command === "compare" &&
    first &&
    second &&
    (third === undefined || (third === "--exclude-data-tables" && fourth))
  ) {
    const excluded =
      third === "--exclude-data-tables" && fourth !== undefined
        ? new Set((await Bun.file(fourth).text()).split("\n").filter(Boolean))
        : new Set<string>();
    const differences = compareCatalogs(
      await Bun.file(first).json(),
      await Bun.file(second).json(),
      excluded,
    );
    if (differences.length > 0) {
      console.error(differences.join("\n"));
      process.exitCode = 2;
    } else {
      console.log("catalogs match");
    }
  } else {
    console.error(
      "Usage: bun scripts/migration-catalog.ts snapshot | seed-footprint <before.json> <after.json> | compare <a.json> <b.json> [--exclude-data-tables <path>]",
    );
    process.exitCode = 1;
  }
}
