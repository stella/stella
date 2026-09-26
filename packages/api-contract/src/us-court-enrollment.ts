/**
 * The United States courts whose decisions may be written, and the names they
 * are written under. Kept apart from the full directory (`us-courts.ts`) so a
 * reader that only formats or matches the enrolled courts neither loads nor
 * type-checks against every court the source registry holds.
 */
export type { UsWritableCourtId } from "./us-court-vocabulary";
export { US_WRITABLE_COURTS } from "./us-writable-courts.generated";
