import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * Checks migrations 20261016100500 (rule kinds and citation evidence) and
 * 20261016100700 (review text revisions) add NOT VALID. Rows written before
 * them leave the new columns at their defaults, which every check accepts;
 * validating here keeps the scans out of the schema transaction.
 */
export const CITATION_POLARITY_EVIDENCE_CONSTRAINTS = [
  {
    tableName: "case_law_polarity_rules",
    constraintName: "polarity_rules_kind_values",
  },
  {
    tableName: "case_law_polarity_rules",
    constraintName: "polarity_rules_form_neutral",
  },
  {
    tableName: "case_law_citations",
    constraintName: "citations_polarity_source_values",
  },
  {
    tableName: "case_law_citations",
    constraintName: "citations_cited_part_values",
  },
  {
    tableName: "case_law_citations",
    constraintName: "citations_polarity_window_bounds",
  },
  {
    tableName: "case_law_citations",
    constraintName: "citations_polarity_confidence_bounds",
  },
  {
    tableName: "case_law_citation_reviews",
    constraintName: "citation_reviews_text_revision_sha256",
  },
  {
    tableName: "case_law_citation_doctrine_reviews",
    constraintName: "citation_doctrine_reviews_text_revision_sha256",
  },
] as const satisfies readonly OnlineConstraintValidation[];

export const CITATION_POLARITY_EVIDENCE_CONSTRAINT_VALIDATIONS =
  CITATION_POLARITY_EVIDENCE_CONSTRAINTS.map(
    (constraint) =>
      ({
        introducedBy:
          constraint.tableName === "case_law_citation_reviews" ||
          constraint.tableName === "case_law_citation_doctrine_reviews"
            ? "20261030213429_case_law_review_text_revision"
            : "20261030213329_case_law_polarity_kind_evidence",
        name: constraint.constraintName,
        readCompletion: async (connection) =>
          await readConstraintCompletion({
            connection,
            tableName: constraint.tableName,
            constraintName: constraint.constraintName,
            repairName: constraint.constraintName,
          }),
        repair: async (connection, tables) =>
          await validateOnlineConstraints({
            connection,
            tables,
            constraints: [constraint],
          }),
      }) satisfies OnlineRepair,
  );
