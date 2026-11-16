export const IDEMPOTENT_SUBMISSION = Symbol("idempotent submission");

export const readMutationVariables = (value: unknown): unknown => {
  if (
    typeof value === "object" &&
    value !== null &&
    IDEMPOTENT_SUBMISSION in value
  ) {
    return value[IDEMPOTENT_SUBMISSION];
  }
  return value;
};
