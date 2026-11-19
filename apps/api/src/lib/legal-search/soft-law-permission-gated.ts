/**
 * Sources whose publisher limits reuse of the full texts, so stella serves
 * their listing only until the publisher grants permission. Naming one in
 * `SOFT_LAW_FULL_TEXT_PERMITTED_SOURCES` records that permission for a
 * deployment; its reviewed full-text setting lives in `soft-law-serving.ts`.
 * Kept apart from that module so the environment schema can name these
 * without importing the validated environment.
 */
export const SOFT_LAW_PERMISSION_GATED_AUTHORITIES = ["cz-mv-psmv"] as const;

export type SoftLawPermissionGatedAuthority =
  (typeof SOFT_LAW_PERMISSION_GATED_AUTHORITIES)[number];
