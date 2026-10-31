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
