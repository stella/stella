import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";

import * as agentAuthSchema from "@/api/db/agent-auth-schema";
import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawCitations,
  caseLawDecisions,
  caseLawPolarityRules,
} from "@/api/db/schema";
import { POLARITY } from "@/api/handlers/case-law/polarity/consts";

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

  const rendered = new PgDialect().sqlToQuery(check.value).sql;
  const inList = /IN\s*\((?<inList>[^)]+)\)/iu.exec(rendered)?.groups?.[
    "inList"
  ];
  if (inList === undefined) {
    throw new Error(`Could not parse IN list from "${constraintName}"`);
  }

  return inList.split(",").map((v) => v.trim().replace(/^'|'$/gu, ""));
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
  name: string;
  /** `false` for a name drizzle derived from the columns rather than one the schema chose. */
  explicit: boolean;
};

const declaredNames = (): DeclaredName[] => {
  const names: DeclaredName[] = [];

  for (const value of [
    ...Object.values(schema),
    ...Object.values(authSchema),
    ...Object.values(agentAuthSchema),
  ]) {
    if (!is(value, PgTable)) {
      continue;
    }
    const config = getTableConfig(value);
    const table = config.name;

    for (const foreignKey of config.foreignKeys) {
      names.push({
        table,
        name: foreignKey.getName(),
        explicit: foreignKey.reference().name !== undefined,
      });
    }
    for (const name of [
      ...config.indexes.map((index) => index.config.name),
      ...config.uniqueConstraints.map((unique) => unique.name),
      ...config.checks.map((check) => check.name),
      ...config.primaryKeys.map((primaryKey) => primaryKey.getName()),
      ...config.policies.map((policy) => policy.name),
    ]) {
      names.push({ table, name, explicit: true });
    }
  }

  return names;
};

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
  "folio_collab_session_tokens_session_id_folio_collab_sessions_id_fk",
  "folio_collab_sessions_entity_id_workspace_id_entities_id_workspace_id_fk",
  "folio_collab_sessions_property_id_workspace_id_properties_id_workspace_id_fk",
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
    expect(names.length).toBeGreaterThan(500);
  });

  test("no name the schema chooses exceeds PostgreSQL's identifier limit", () => {
    expect(
      names
        .filter(({ explicit }) => explicit)
        .filter(
          ({ name }) =>
            Buffer.byteLength(name) > POSTGRES_IDENTIFIER_LIMIT_BYTES,
        )
        .map(({ table, name }) => `${table}: ${name}`)
        .toSorted(),
    ).toEqual([]);
  });

  test("drizzle-derived names over the limit are exactly the known set", () => {
    expect(
      names
        .filter(
          ({ name }) =>
            Buffer.byteLength(name) > POSTGRES_IDENTIFIER_LIMIT_BYTES,
        )
        .map(({ name }) => name)
        .toSorted(),
    ).toEqual(LEGACY_DERIVED_NAMES_OVER_LIMIT.toSorted());
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
});
