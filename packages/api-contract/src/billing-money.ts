import * as v from "valibot";

export const MONEY_SCHEMA_BRAND = "Money";

/** Monetary response values retain their domain identity in schemas and static types. */
export const moneySchema = v.pipe(v.number(), v.brand(MONEY_SCHEMA_BRAND));
/** The classification applies to numeric amounts, decimal text, and financial artifacts. */
export type Money = v.Brand<typeof MONEY_SCHEMA_BRAND>;
export const moneyTextSchema = v.pipe(
  v.string(),
  v.regex(/^-?\d+$/u),
  v.brand(MONEY_SCHEMA_BRAND),
);
/** A binary financial export carries the same classification as structured money. */
export const moneyExportSchema = v.pipe(
  v.unknown(),
  v.brand(MONEY_SCHEMA_BRAND),
);

/** Refusals of changing a member's billing visibility, for clients and agents to branch on. */
export const MEMBER_BILLING_ACCESS_REFUSAL_CODE = {
  memberNotFound: "member_billing_access_member_not_found",
} as const;
