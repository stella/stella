export const LAW_READ_REFUSAL_CODE = {
  accessUnavailable: "access_unavailable",
  missingScope: "missing_scope",
  notEntitled: "not_entitled",
} as const;

export type LawReadRefusalCode =
  (typeof LAW_READ_REFUSAL_CODE)[keyof typeof LAW_READ_REFUSAL_CODE];
