import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * The table-level privileges the request role `stella` holds once every
 * committed migration has run, derived from the migration text.
 *
 * The PGlite harness builds its schema by pushing the Drizzle definitions, so
 * it never runs the GRANT and REVOKE statements the migrations carry. Granting
 * the role every table instead hides each privilege the deployment withholds:
 * a suite can then write to an append-only history table that production
 * refuses to let the role touch. The harness applies this derivation instead,
 * and `pglite-role-grants.test.ts` holds its catalog to it.
 *
 * Column grants are not table privileges and are left to the column mirror.
 */

const TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
] as const;

export type TablePrivilege = (typeof TABLE_PRIVILEGES)[number];

const STELLA_ROLE = "stella";

const READ_WRITE: readonly TablePrivilege[] = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
];

type RelationState = {
  privileges: Set<TablePrivilege>;
  rowSecurity: boolean;
};

type StellaPrivilegeState = Map<string, RelationState>;

/**
 * A statement that grants or revokes through `format()` names its relation at
 * run time, so the text alone cannot say which relation it reaches. Each such
 * migration is expanded here by hand, and an unlisted one fails the mirror
 * test rather than being skipped.
 */
type DynamicExpansion = (state: StellaPrivilegeState) => void;

const grantTo = (
  state: StellaPrivilegeState,
  relation: string,
  privileges: readonly TablePrivilege[],
): void => {
  const current = state.get(relation) ?? {
    privileges: new Set<TablePrivilege>(),
    rowSecurity: false,
  };
  for (const privilege of privileges) {
    current.privileges.add(privilege);
  }
  state.set(relation, current);
};

/** The case-law tables the role bootstrap keeps out of its blanket grant. */
const BOOTSTRAP_EXCLUDED_RELATIONS = new Set([
  "case_law_sources",
  "case_law_decisions",
  "case_law_citations",
  "case_law_polarity_rules",
  "case_law_court_weights",
  "case_law_fts_configs",
  "case_law_search_documents",
  "case_law_ingestion_events",
  "case_law_ingestion_failures",
]);

const LEGAL_LIST_RELATIONS = [
  "legal_lists",
  "legal_list_sections",
  "legal_list_columns",
  "legal_list_items",
  "legal_list_item_sources",
  "legal_list_generation_runs",
  "legal_list_generation_sources",
  "legal_list_generation_candidates",
  "legal_list_generation_candidate_sources",
  "legal_list_item_comments",
  "legal_list_item_reviews",
] as const;

const DYNAMIC_STELLA_GRANTS: Readonly<Record<string, DynamicExpansion>> = {
  // Every row-secured relation that exists at this point, bar the case-law
  // tables the same block excludes by name.
  "20260510140000_document_rls_role_bootstrap": (state) => {
    for (const [relation, current] of state) {
      if (current.rowSecurity && !BOOTSTRAP_EXCLUDED_RELATIONS.has(relation)) {
        grantTo(state, relation, READ_WRITE);
      }
    }
  },
  "20260808014000_legal_lists": (state) => {
    for (const relation of LEGAL_LIST_RELATIONS) {
      grantTo(state, relation, READ_WRITE);
    }
  },
};

const NAME = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED_NAME = String.raw`(?:${NAME}\s*\.\s*)?${NAME}`;

/**
 * One pass over a migration, in text order, picking out every statement that
 * changes which relations exist, whether they are row-secured, or who may use
 * them. Order matters: a REVOKE before a GRANT is not the same migration as
 * the reverse.
 */
const EVENT = new RegExp(
  [
    String.raw`(?<create>\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMPORARY|TEMP)\s+|UNLOGGED\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+(?<createIfNotExists>IF\s+NOT\s+EXISTS\s+)?(?<createName>${QUALIFIED_NAME}))`,
    String.raw`(?<drop>\bDROP\s+(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?(?<dropNames>${QUALIFIED_NAME}(?:\s*,\s*${QUALIFIED_NAME})*))`,
    String.raw`(?<rename>\bALTER\s+(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?<renameFrom>${QUALIFIED_NAME})\s+RENAME\s+TO\s+(?<renameTo>${NAME}))`,
    String.raw`(?<rowSecurity>\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?<rowSecurityName>${QUALIFIED_NAME})\s+(?<rowSecurityMode>ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY)`,
    String.raw`(?<privilege>\b(?<verb>GRANT|REVOKE)\s+(?:GRANT\s+OPTION\s+FOR\s+)?(?<privileges>[^;']*?)\s+ON\s+(?<objects>[^;']*?)\s+(?<direction>TO|FROM)\s+(?<roles>[^;']*?)(?=\s*(?:;|'|$|\bWITH\b|\bGRANTED\b|\bCASCADE\b|\bRESTRICT\b)))`,
  ].join("|"),
  "giu",
);

const ALL_TABLES_IN_SCHEMA =
  /^ALL\s+TABLES\s+IN\s+SCHEMA\s+(?<schemas>[^;]+)$/iu;

/** The object class of `ALTER DEFAULT PRIVILEGES ... ON TABLES`. */
const DEFAULT_TABLES = /^TABLES$/iu;

const NOT_A_RELATION =
  /^(?:ALL\s+(?:TABLES|SEQUENCES|FUNCTIONS|PROCEDURES|ROUTINES)\b|TABLES\b|SEQUENCES\b|FUNCTIONS\b|SCHEMA\b|SEQUENCE\b|FUNCTION\b|PROCEDURE\b|ROUTINE\b|DATABASE\b|DOMAIN\b|TYPE\b|LANGUAGE\b|LARGE\s+OBJECT\b|FOREIGN\b|TABLESPACE\b|PARAMETER\b)/iu;

/** `"public"."x"`, `public.x` and `x` are the same relation. */
const relationName = (qualified: string): string => {
  const parts = [
    ...qualified.matchAll(/"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*)/gu),
  ].map((part) => part[1] ?? (part[2] ?? "").toLowerCase());
  return parts.at(-1) ?? "";
};

const splitTopLevel = (text: string): string[] => {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }
    if (character === "," && depth === 0) {
      items.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  items.push(current.trim());
  return items.filter((item) => item.length > 0);
};

/**
 * The table-level privileges a privilege list names. A column-scoped entry
 * such as `UPDATE (status)` is a column grant and contributes nothing here.
 */
const tablePrivileges = (privilegeList: string): TablePrivilege[] => {
  const privileges: TablePrivilege[] = [];
  for (const item of splitTopLevel(privilegeList)) {
    if (item.includes("(")) {
      continue;
    }
    const word = item.toUpperCase().replaceAll(/\s+/gu, " ");
    if (word === "ALL" || word === "ALL PRIVILEGES") {
      return [...TABLE_PRIVILEGES];
    }
    const privilege = TABLE_PRIVILEGES.find((known) => known === word);
    if (privilege !== undefined) {
      privileges.push(privilege);
    }
  }
  return privileges;
};

const stripComments = (sqlText: string): string =>
  sqlText.replaceAll(/--[^\n]*/gu, "");

export type MigrationSource = { name: string; sql: string };

export type StellaPrivilegeDerivation = {
  privileges: ReadonlyMap<string, ReadonlySet<TablePrivilege>>;
  /** Migrations that grant or revoke `stella` through `format()` unexpanded. */
  unexpandedDynamicMigrations: readonly string[];
  /** Expansions no migration needs any more. */
  unusedDynamicExpansions: readonly string[];
  /** Statements granting `stella` a form the fold cannot apply. */
  unsupportedStatements: readonly string[];
};

type ApplyPrivilegesOptions = {
  state: StellaPrivilegeState;
  verb: string;
  privileges: readonly TablePrivilege[];
  relations: readonly string[];
};

const applyPrivileges = ({
  state,
  verb,
  privileges,
  relations,
}: ApplyPrivilegesOptions): void => {
  for (const relation of relations) {
    if (verb === "GRANT") {
      grantTo(state, relation, privileges);
      continue;
    }
    for (const privilege of privileges) {
      state.get(relation)?.privileges.delete(privilege);
    }
  }
};

/**
 * Fold the migrations, in order, into the role's table privileges. A relation
 * starts with none: the role bootstrap revoked the default privileges, so a
 * table a later migration creates is closed to `stella` until a migration
 * grants it.
 */
export const deriveStellaTablePrivileges = (
  migrations: readonly MigrationSource[],
  dynamicGrants: Readonly<
    Record<string, DynamicExpansion>
  > = DYNAMIC_STELLA_GRANTS,
): StellaPrivilegeDerivation => {
  const state: StellaPrivilegeState = new Map();
  const unexpanded = new Set<string>();
  const used = new Set<string>();
  const unsupported = new Set<string>();

  for (const migration of migrations) {
    let dynamicApplied = false;
    for (const match of stripComments(migration.sql).matchAll(EVENT)) {
      const groups = match.groups ?? {};
      if (groups["create"] !== undefined) {
        const name = relationName(groups["createName"] ?? "");
        const replaces = /\bOR\s+REPLACE\b/iu.test(groups["create"]);
        if (
          !state.has(name) ||
          (groups["createIfNotExists"] === undefined && !replaces)
        ) {
          state.set(name, {
            privileges: new Set(),
            rowSecurity: false,
          });
        }
        continue;
      }
      if (groups["drop"] !== undefined) {
        for (const name of splitTopLevel(groups["dropNames"] ?? "")) {
          state.delete(relationName(name));
        }
        continue;
      }
      if (groups["rename"] !== undefined) {
        const from = relationName(groups["renameFrom"] ?? "");
        const current = state.get(from);
        state.delete(from);
        if (current !== undefined) {
          state.set(relationName(groups["renameTo"] ?? ""), current);
        }
        continue;
      }
      if (groups["rowSecurity"] !== undefined) {
        const name = relationName(groups["rowSecurityName"] ?? "");
        const current = state.get(name);
        if (current !== undefined) {
          current.rowSecurity =
            (groups["rowSecurityMode"] ?? "").toUpperCase() === "ENABLE";
        }
        continue;
      }
      const verb = (groups["verb"] ?? "").toUpperCase();
      const direction = (groups["direction"] ?? "").toUpperCase();
      if (
        (verb === "GRANT") !== (direction === "TO") ||
        !splitTopLevel(groups["roles"] ?? "").some(
          (role) => relationName(role) === STELLA_ROLE,
        )
      ) {
        continue;
      }
      const objects = (groups["objects"] ?? "").trim();
      const privileges = tablePrivileges(groups["privileges"] ?? "");
      const allTables = ALL_TABLES_IN_SCHEMA.exec(objects);
      if (allTables !== null) {
        // PostgreSQL's ALL TABLES covers views and materialized views too;
        // only the public schema is mirrored.
        const schemas = splitTopLevel(allTables.groups?.["schemas"] ?? "");
        if (schemas.some((schema) => relationName(schema) === "public")) {
          applyPrivileges({
            state,
            verb,
            privileges,
            relations: [...state.keys()],
          });
        }
        continue;
      }
      // Default privileges reach only relations created later. The fold
      // starts every relation closed, which a default REVOKE agrees with; a
      // default GRANT would open them, so it is reported, not dropped.
      if (DEFAULT_TABLES.test(objects)) {
        if (verb === "GRANT") {
          unsupported.add(
            `${migration.name}: ${match[0].replaceAll(/\s+/gu, " ")}`,
          );
        }
        continue;
      }
      if (NOT_A_RELATION.test(objects)) {
        continue;
      }
      if (objects.includes("%")) {
        const expansion = dynamicGrants[migration.name];
        if (expansion === undefined) {
          unexpanded.add(migration.name);
        } else if (!dynamicApplied) {
          expansion(state);
          dynamicApplied = true;
          used.add(migration.name);
        }
        continue;
      }
      applyPrivileges({
        state,
        verb,
        privileges,
        relations: splitTopLevel(objects.replace(/^TABLE\s+/iu, "")).map(
          relationName,
        ),
      });
    }
  }

  return {
    unsupportedStatements: [...unsupported].toSorted(),
    privileges: new Map(
      [...state].map(([name, current]) => [name, current.privileges]),
    ),
    unexpandedDynamicMigrations: [...unexpanded].toSorted(),
    unusedDynamicExpansions: Object.keys(dynamicGrants)
      .filter((name) => !used.has(name))
      .toSorted(),
  };
};

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");

/** Every committed migration, in the order the migrator applies them. */
export const readCommittedMigrations = (): MigrationSource[] =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .flatMap((name) => {
      try {
        return [
          {
            name,
            sql: readFileSync(
              nodePath.join(MIGRATIONS_DIR, name, "migration.sql"),
              "utf-8",
            ),
          },
        ];
      } catch {
        // swallow-ok: a migration folder without SQL carries no grants
        return [];
      }
    });

/** The quoted SQL that sets `relation` to exactly the derived privileges. */
export const stellaTablePrivilegeStatements = (
  relation: string,
  privileges: ReadonlySet<TablePrivilege>,
): string[] => {
  const quoted = `"${relation.replaceAll('"', '""')}"`;
  const granted = TABLE_PRIVILEGES.filter((privilege) =>
    privileges.has(privilege),
  );
  return [
    `REVOKE ALL PRIVILEGES ON TABLE ${quoted} FROM ${STELLA_ROLE}`,
    ...(granted.length > 0
      ? [`GRANT ${granted.join(", ")} ON TABLE ${quoted} TO ${STELLA_ROLE}`]
      : []),
  ];
};
