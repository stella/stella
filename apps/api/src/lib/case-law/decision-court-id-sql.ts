/**
 * Which jurisdictions identify a decision's court by a directory id, and the
 * table constraint that holds every row to it. Kept apart from the resolver
 * (`decision-court-identity.ts`) so the schema can render the constraint
 * without loading a court directory.
 */
import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";

/**
 * The jurisdictions whose decisions store a directory court id beside the
 * court's name. Every other jurisdiction identifies a court by the name the
 * publisher prints and stores no id.
 */
export const COURT_DIRECTORY_JURISDICTIONS = [
  "USA",
] as const satisfies readonly CaseLawJurisdiction[];

export type CourtDirectoryJurisdiction =
  (typeof COURT_DIRECTORY_JURISDICTIONS)[number];

/** Storage bound of `case_law_decisions.court_id`. */
export const DECISION_COURT_ID_MAX_LENGTH = 64;

/** The `case_law_decisions` CHECK that holds `decisionCourtIdByCountrySql`. */
export const CASE_LAW_DECISION_COURT_ID_CONSTRAINT =
  "case_law_decisions_court_id_by_country";

/**
 * A row carries a court id exactly when its country is a directory
 * jurisdiction. Literal SQL with no parameters, so the same text serves in a
 * CHECK.
 */
export const decisionCourtIdByCountrySql = (
  country: SQLWrapper,
  courtId: SQLWrapper,
): SQL =>
  sql`(${country} IN (${sql.raw(
    COURT_DIRECTORY_JURISDICTIONS.map((code) => `'${code}'`).join(", "),
  )})) = (${courtId} IS NOT NULL)`;
