/**
 * The professional-use statement shown where accounts are created
 * (`auth.professionalUseStatement` in the web catalogs). Changing the English
 * statement changes its hash; update the version and the hash together.
 */
export const PROFESSIONAL_USE_STATEMENT_VERSION = "2026-10";

/** SHA-256 of the English statement this version names. */
export const PROFESSIONAL_USE_STATEMENT_SHA256 =
  "d4ae049f755b017246cccc22405611ecf214ffd84b8c8354d10a16a6d14819d5";

/**
 * The registration request field naming the statement version the page
 * displayed: in the body of an email-OTP sign-in or the bootstrap sign-up,
 * and in `additionalData` of a social sign-in, which the OAuth state carries
 * to the callback that creates the account. An account is created accepted
 * only when it names the current version.
 */
export const PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD =
  "professionalUseStatementVersion";

/** The terms of service the statement is accepted under. */
export const PROFESSIONAL_USE_TERMS_VERSION = "2026-10";

/**
 * An account's professional-use state: `accepted` once it has accepted the
 * statement, `required` until then. An account created where the statement
 * was not shown starts `required` and accepts on its first interactive
 * sign-in.
 */
export const PROFESSIONAL_USE_STATUS = {
  accepted: "accepted",
  required: "required",
} as const;

/** The error code a signed-in request answers with until the account accepts. */
export const PROFESSIONAL_USE_REQUIRED_CODE =
  "professional_use_acceptance_required";
