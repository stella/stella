// parser-output-unchanged: the court id CHECK admits ids on printed-name jurisdictions; no adapter parses differently.
/**
 * Which jurisdictions identify a decision's court by a directory id, and the
 * table constraint that holds every row to it. Kept apart from the resolver
 * (`decision-court-identity.ts`) so the schema can render the constraint
 * without loading a court directory.
 */
import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { PRINTED_COURT_JURISDICTIONS } from "@stll/api-contract/court-identity";

/**
 * The jurisdictions whose sources state a directory court id, which the
 * decision stores beside the court's name and every rank reads the court by.
 * A jurisdiction whose sources print only a name either reads it onto its
 * own directory's id at the write boundary (`PRINTED_COURT_JURISDICTIONS`,
 * `decision-court-identity.ts`) or stores the name alone.
 */
export const COURT_DIRECTORY_JURISDICTIONS = [
  "USA",
] as const satisfies readonly CaseLawJurisdiction[];

export type CourtDirectoryJurisdiction =
  (typeof COURT_DIRECTORY_JURISDICTIONS)[number];

export const isCourtDirectoryJurisdiction = (
  country: string,
): country is CourtDirectoryJurisdiction =>
  COURT_DIRECTORY_JURISDICTIONS.some((code) => code === country);

/** Storage bound of `case_law_decisions.court_id`. */
export const DECISION_COURT_ID_MAX_LENGTH = 64;

/** The `case_law_decisions` CHECK that holds `decisionCourtIdByCountrySql`. */
export const CASE_LAW_DECISION_COURT_ID_CONSTRAINT =
  "case_law_decisions_court_id_by_country";

const sqlList = (codes: readonly string[]): SQL =>
  sql.raw(codes.map((code) => `'${code}'`).join(", "));

/**
 * A directory jurisdiction's row carries a court id; a printed-name
 * jurisdiction's row (`PRINTED_COURT_JURISDICTIONS`) may, since every write
 * gives it one but rows stored before that hold none until they are
 * repaired; every other row carries none. Literal SQL with no parameters, so
 * the same text serves in a CHECK.
 */
export const decisionCourtIdByCountrySql = (
  country: SQLWrapper,
  courtId: SQLWrapper,
): SQL =>
  sql`(CASE WHEN ${country} IN (${sqlList(COURT_DIRECTORY_JURISDICTIONS)}) THEN ${courtId} IS NOT NULL WHEN ${country} IN (${sqlList(PRINTED_COURT_JURISDICTIONS)}) THEN true ELSE ${courtId} IS NULL END)`;
