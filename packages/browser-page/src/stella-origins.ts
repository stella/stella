import { PRODUCTION_STELLA_ORIGINS } from "@stll/api-contract/browser-control";

/** Hosted staging stella; only the extension's `staging` build trusts it by default. */
export const STAGING_STELLA_ORIGINS = ["https://staging.stll.app"] as const;

/**
 * Every hosted stella, trusted by a build or not: no browser host opens,
 * reads or acts on a page of one, whichever account it serves.
 */
export const HOSTED_STELLA_ORIGINS = [
  ...PRODUCTION_STELLA_ORIGINS,
  ...STAGING_STELLA_ORIGINS,
] as const;
