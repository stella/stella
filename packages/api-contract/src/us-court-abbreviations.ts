/**
 * The United States courts cited under a decided abbreviation, and the names
 * their decisions are stored under. Kept apart from the full directory
 * (`us-courts.ts`) so a reader that only formats these courts neither loads
 * nor type-checks against every court the source registry holds.
 */
export type { UsAbbreviatedCourtId } from "./us-court-vocabulary";
export { US_ABBREVIATED_COURTS } from "./us-abbreviated-courts.generated";
