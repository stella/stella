/**
 * Why the mail provider will not deliver to an account's address:
 * - `hard_bounce`: the receiving server refused the address permanently;
 * - `complaint`: the recipient reported our mail as unwanted;
 * - `suppressed`: the provider's suppression list holds the address, so it
 *   drops every send without trying.
 * Loads nothing, so the schema and the owner module can both depend on it.
 */
export const ACCOUNT_EMAIL_UNDELIVERABLE_REASONS = [
  "hard_bounce",
  "complaint",
  "suppressed",
] as const;

export type AccountEmailUndeliverableReason =
  (typeof ACCOUNT_EMAIL_UNDELIVERABLE_REASONS)[number];
