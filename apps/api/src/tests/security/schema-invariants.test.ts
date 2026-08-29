import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import * as agentAuthSchema from "@/api/db/agent-auth-schema";
import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";
import { SCOPED_NATIVE_EXTRACTION_ENQUEUE } from "@/api/db/schema";
import { POLARITY } from "@/api/handlers/case-law/polarity/consts";
import { DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";

const {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
} = schema;

const MIGRATIONS_DIR = path.join(import.meta.dir, "../../../drizzle");
const NAMED_CHECK = /CONSTRAINT\s+"(?<name>[a-z_0-9]+)"\s+CHECK\s*\(/giu;

/**
 * The text inside the parenthesis opening at `open`, matched by depth.
 *
 * An IN list read with `[^)]+` stops at the first `)`, which is the wrong
 * place whenever a value or a cast puts one inside the list. Reading the
 * whole balanced group is what lets one parser serve both the rendered
 * schema and the migration files.
 */
const balancedGroup = (sql: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    if (sql[index] === "(") {
      depth += 1;
    } else if (sql[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return sql.slice(open + 1, index);
      }
    }
  }
  throw new Error(`Unbalanced parenthesis at offset ${String(open)}`);
};

/**
 * The quoted literals of every `IN (...)` list, in source order.
 *
 * Every list, not the first: a compound check gives each branch its own
 * vocabulary (`document_review_findings_outcome_check` has one list per check
 * kind, `case_law_citation_resolution_census_bucket_values` one per bucket
 * kind). Reading only the first would leave every later list unguarded while
 * the constraint still looked covered. Order carries the branch each list
 * belongs to, so it is compared as a sequence rather than a set.
 */
const inListGroups = (sql: string): string[][] => {
  const groups: string[][] = [];
  const opener = /\bIN\s*\(/giu;
  let match = opener.exec(sql);

  while (match) {
    const open = match.index + match[0].length - 1;
    const group = balancedGroup(sql, open);
    groups.push(
      group.split(",").map((value) => value.trim().replace(/^'|'$/gu, "")),
    );
    // Resume past this group, so a nested `IN` inside it is not read twice.
    opener.lastIndex = open + group.length + 2;
    match = opener.exec(sql);
  }

  return groups;
};

/**
 * A schema CHECK as the database reads it: rendered, with the dialect's bound
 * parameters put back. A constant interpolated as a value arrives as `$1`
 * rather than its literal, and a placeholder compares equal to nothing.
 */
const renderCheck = (check: { value: SQL }): string => {
  const query = new PgDialect().sqlToQuery(check.value);
  return query.sql.replace(/\$(\d+)/gu, (placeholder, index: string) => {
    const bound = query.params[Number(index) - 1];
    // Only a scalar can be a member of an IN list. Anything else is left as
    // the placeholder, which matches no migration value and so is reported
    // rather than stringified into a comparison that cannot mean anything.
    return typeof bound === "string" || typeof bound === "number"
      ? String(bound)
      : placeholder;
  });
};

/**
 * Allowed values of a CHECK constraint's IN list, read off the statement the
 * dialect renders. The list is built by interpolating the canonical const, so
 * each value arrives as its own SQL chunk; only the rendered text shows what
 * the database is asked to enforce.
 */
const extractCheckValues = (
  tableDef: Parameters<typeof getTableConfig>[0],
  constraintName: string,
): string[] => {
  const config = getTableConfig(tableDef);
  const check = config.checks.find((c) => c.name === constraintName);
  if (!check) {
    throw new Error(`CHECK constraint "${constraintName}" not found`);
  }

  const groups = inListGroups(renderCheck(check));
  const values = groups.at(0);
  if (values === undefined) {
    throw new Error(`Could not parse IN list from "${constraintName}"`);
  }
  if (groups.length > 1) {
    throw new Error(
      `"${constraintName}" has ${String(groups.length)} IN lists; this helper reads one`,
    );
  }

  return values;
};

/**
 * Every named CHECK constraint the committed migrations define with an IN
 * list, as the last migration to define it leaves it.
 *
 * Production is built from these files, not from the schema: `db:push` is
 * local-only. So the schema is where a constraint is declared and this is
 * what the database actually enforces, and the two are bound by nothing but
 * a hand-written migration.
 */
const migrationCheckValues = (): Map<
  string,
  { migration: string; groups: string[][] }
> => {
  const constraints = new Map<
    string,
    { migration: string; groups: string[][] }
  >();
  const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  for (const migration of migrations) {
    let sql: string;
    try {
      sql = readFileSync(
        path.join(MIGRATIONS_DIR, migration, "migration.sql"),
        "utf-8",
      );
    } catch {
      continue;
    }

    for (const match of sql.matchAll(NAMED_CHECK)) {
      const name = match.groups?.["name"];
      if (name === undefined) {
        continue;
      }

      const groups = inListGroups(
        balancedGroup(sql, match.index + match[0].length - 1),
      );
      if (groups.length > 0) {
        constraints.set(name, { migration, groups });
      }
    }
  }

  return constraints;
};

/**
 * PostgreSQL stores identifiers in a fixed 63-byte field and silently clips
 * anything longer. A constraint or index whose declared name is longer is
 * still created, still enforced, and still correct: what it is not is the name
 * the schema says it has, which is what drift detection compares and what any
 * later statement naming it has to spell.
 */
const POSTGRES_IDENTIFIER_LIMIT_BYTES = 63;

type DeclaredName = {
  table: string;
  /** `undefined` when drizzle holds no name at all, so nothing can be measured. */
  name: string | undefined;
  /** `false` for a name drizzle derived from the columns rather than one the schema chose. */
  explicit: boolean;
};

// `is()` is drizzle-orm's own runtime type guard (it checks the entity-kind tag
// drizzle stamps on table instances), so this narrows `unknown` to `PgTable`
// without an unsafe type assertion.
const isPgTable = (value: unknown): value is PgTable => is(value, PgTable);

// Spread into one annotated record rather than walking each namespace: the
// annotation collapses the exports to `unknown` immediately, so neither the
// traversal nor its inference has to build a union of every table type. The
// three namespaces share no export name, so nothing is lost to a collision.
const allSchemaExports: Record<string, unknown> = {
  ...agentAuthSchema,
  ...authSchema,
  ...schema,
};

const declaredNames = (): DeclaredName[] => {
  const names: DeclaredName[] = [];

  for (const value of Object.values(allSchemaExports)) {
    if (!isPgTable(value)) {
      continue;
    }
    const config = getTableConfig(value);
    const table = config.name;

    // `isNameExplicit` is drizzle's own record of whether the schema chose the
    // name or drizzle derived it from the columns; every object kind below
    // reports it, so this never has to guess from the shape of the string.
    for (const foreignKey of config.foreignKeys) {
      names.push({
        table,
        name: foreignKey.getName(),
        explicit: foreignKey.isNameExplicit(),
      });
    }
    for (const index of config.indexes) {
      names.push({
        table,
        name: index.config.name,
        explicit: index.isNameExplicit,
      });
    }
    for (const unique of config.uniqueConstraints) {
      names.push({
        table,
        name: unique.getName(),
        explicit: unique.isNameExplicit,
      });
    }
    for (const primaryKey of config.primaryKeys) {
      names.push({
        table,
        name: primaryKey.getName(),
        explicit: primaryKey.isNameExplicit,
      });
    }
    for (const check of config.checks) {
      names.push({ table, name: check.name, explicit: true });
    }
    for (const policy of config.policies) {
      names.push({ table, name: policy.name, explicit: true });
    }
  }

  return names;
};

const overLimit = (names: readonly DeclaredName[]): DeclaredName[] =>
  names.filter(
    ({ name }) =>
      name !== undefined &&
      Buffer.byteLength(name) > POSTGRES_IDENTIFIER_LIMIT_BYTES,
  );

/**
 * Foreign keys whose drizzle-derived name is longer than PostgreSQL can store.
 * None of them reaches the database under this name: each was created by a
 * migration that named it by hand or let PostgreSQL name it, so the truncation
 * is latent rather than live. It stops being latent the moment one of these
 * tables is created from the schema instead of from its migration.
 *
 * The set is asserted exactly, in both directions, so an entry cannot outlive
 * the constraint it describes and a new long name cannot join it unnoticed.
 * Fix an entry by naming the constraint in the schema and renaming it in a
 * migration, the way 20260813110000 did for the eleven that were live.
 */
const LEGACY_DERIVED_NAMES_OVER_LIMIT = [
  "case_law_citations_polarity_rule_id_case_law_polarity_rules_id_fk",
  "case_law_decision_source_identities_source_id_case_law_sources_id_fk",
  "case_law_search_document_preview_passages_decision_id_case_law_search_documents_decision_id_fk",
  "chat_thread_search_preview_passages_thread_id_chat_thread_search_documents_thread_id_fk",
  "clause_variants_clause_id_organization_id_clauses_id_organization_id_fk",
  "clause_versions_clause_id_organization_id_clauses_id_organization_id_fk",
  "contact_search_document_preview_passages_contact_id_contact_search_documents_contact_id_fk",
  "desktop_edit_handoffs_entity_id_workspace_id_entities_id_workspace_id_fk",
  "desktop_edit_handoffs_property_id_workspace_id_properties_id_workspace_id_fk",
  "desktop_edit_sessions_entity_id_workspace_id_entities_id_workspace_id_fk",
  "desktop_edit_sessions_finalized_version_id_entity_versions_id_fk",
  "desktop_edit_sessions_property_id_workspace_id_properties_id_workspace_id_fk",
  "document_processing_runs_entity_id_workspace_id_entities_id_workspace_id_fk",
  "document_processing_runs_field_id_workspace_id_fields_id_workspace_id_fk",
  "entity_version_ai_summaries_entity_id_workspace_id_entities_id_workspace_id_fk",
  "entity_version_ai_summaries_entity_version_id_entity_versions_id_fk",
  "entity_versions_entity_id_workspace_id_entities_id_workspace_id_fk",
  "extracted_content_entity_id_workspace_id_entities_id_workspace_id_fk",
  "extracted_content_source_entity_version_id_entity_versions_id_fk",
  "legislation_search_documents_document_id_legislation_documents_id_fk",
  "office_file_evidence_entity_id_workspace_id_entities_id_workspace_id_fk",
  "office_file_evidence_field_id_workspace_id_fields_id_workspace_id_fk",
  "property_dependencies_depends_on_property_id_workspace_id_properties_id_workspace_id_fk",
  "property_dependencies_property_id_workspace_id_properties_id_workspace_id_fk",
  "search_document_preview_passages_entity_id_search_documents_entity_id_fk",
  "template_clauses_template_id_organization_id_templates_id_organization_id_fk",
  "template_persistence_requests_organization_id_organization_id_fk",
  "template_versions_template_id_organization_id_templates_id_organization_id_fk",
  "work_obligation_events_obligation_entity_id_workspace_id_work_obligations_entity_id_workspace_id_fk",
  "work_obligations_entity_id_workspace_id_entities_id_workspace_id_fk",
  "workspace_search_document_preview_passages_workspace_id_workspace_search_documents_workspace_id_fk",
];

describe("identifier length", () => {
  const names = declaredNames();

  // A traversal that silently stopped finding constraints would make every
  // assertion below pass for the wrong reason.
  test("the schema declares the names this guard reads", () => {
    expect(names.length).toBeGreaterThan(1000);
  });

  // An object drizzle holds no name for has nothing to measure, so it would
  // slip past the length assertions entirely. There are none today; this keeps
  // the guard total rather than merely broad.
  test("every constraint and index carries a name to measure", () => {
    expect(
      names
        .filter(({ name }) => name === undefined)
        .map(({ table }) => table)
        .toSorted(),
    ).toEqual([]);
  });

  test("no name the schema chooses exceeds PostgreSQL's identifier limit", () => {
    expect(
      overLimit(names)
        .filter(({ explicit }) => explicit)
        .map(({ table, name }) => `${table}: ${name}`)
        .toSorted(),
    ).toEqual([]);
  });

  test("drizzle-derived names over the limit are exactly the known set", () => {
    const byCodepoint = (a: string | undefined, b: string | undefined) => {
      const left = a ?? "";
      const right = b ?? "";
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    };
    expect(
      overLimit(names)
        .map(({ name }) => name)
        .toSorted(byCodepoint),
    ).toEqual(LEGACY_DERIVED_NAMES_OVER_LIMIT.toSorted(byCodepoint));
  });
});

describe("schema invariants", () => {
  const polarityValues = Object.values(POLARITY).toSorted();

  test("citations CHECK constraint matches POLARITY values", () => {
    const dbValues = extractCheckValues(
      caseLawCitations,
      "citations_polarity_values",
    ).toSorted();
    expect(dbValues).toEqual(polarityValues);
  });

  test("polarity_rules CHECK constraint matches POLARITY values", () => {
    const dbValues = extractCheckValues(
      caseLawPolarityRules,
      "polarity_rules_polarity_values",
    ).toSorted();
    expect(dbValues).toEqual(polarityValues);
  });

  test("corpus mirror CHECK constraint matches its domain type", () => {
    const dbValues = extractCheckValues(
      caseLawDecisions,
      "case_law_decisions_corpus_mirror_status_values",
    ).toSorted();
    expect(dbValues).toEqual(
      Object.values(CASE_LAW_CORPUS_MIRROR_STATUS).toSorted(),
    );
  });

  test("the scoped enqueue policy pins the contract's processor version", () => {
    // The policy admits one `processor_version`, because that column is part
    // of the conflict identity: left free, a scoped session could walk it and
    // mint unlimited dispatchable runs for one source. The literal lives in a
    // migration, which is frozen by design, so bumping
    // DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION without a new policy
    // migration would leave the database rejecting every enqueue the
    // application writes. That has to fail here, loudly, rather than in
    // production.
    const migration = readFileSync(
      path.join(
        import.meta.dir,
        "../../../drizzle/20260813230000_document_processing_scoped_enqueue/migration.sql",
      ),
      "utf-8",
    );

    expect(SCOPED_NATIVE_EXTRACTION_ENQUEUE.processorVersion).toBe(
      DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
    );
    expect(migration).toContain(
      `processor_version = ${String(SCOPED_NATIVE_EXTRACTION_ENQUEUE.processorVersion)}`,
    );
  });

  test("every CHECK constraint's values are enforced by the migrations", () => {
    // The schema builds each of these lists from the canonical const, so it
    // is right by construction and a mirror test against the const passes
    // whatever the database does. Production is migrated, never pushed: what
    // the database enforces is the last migration to name the constraint, and
    // nothing binds the two but somebody remembering to write one. A value
    // added to the const without a migration is not a rejected value, it is a
    // rejected statement — the whole write fails, taking with it every row it
    // touched — and that has to fail here rather than in production.
    const migrations = migrationCheckValues();
    const declared: { table: string; name: string; groups: string[][] }[] = [];

    for (const value of Object.values(schema)) {
      if (!isPgTable(value)) {
        continue;
      }
      const config = getTableConfig(value);
      for (const check of config.checks) {
        const groups = inListGroups(renderCheck(check));
        if (groups.length > 0) {
          declared.push({ table: config.name, name: check.name, groups });
        }
      }
    }

    // Guards the parser rather than the schema: a rendering change that stops
    // producing IN lists would empty the set and pass every assertion below.
    expect(declared.length).toBeGreaterThan(100);

    // Sort within each list (order inside an IN list is meaningless) but not
    // across lists: a compound check's branches are positional, so a value
    // moving between branches has to read as a difference.
    const normalize = (groups: string[][]): string =>
      JSON.stringify(groups.map((group) => group.toSorted()));

    const unenforced = declared.filter(({ name, groups }) => {
      const migrated = migrations.get(name)?.groups;
      return (
        migrated === undefined || normalize(migrated) !== normalize(groups)
      );
    });

    expect(
      unenforced.map(({ table, name, groups }) => ({
        constraint: `${table}.${name}`,
        schema: groups.map((group) => group.toSorted()),
        migration:
          migrations.get(name)?.groups.map((group) => group.toSorted()) ?? null,
      })),
    ).toEqual([]);
  });
});
