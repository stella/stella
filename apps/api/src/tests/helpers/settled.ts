import { Result } from "better-result";

/**
 * A Result-returning call's value, or its error rejected, so a test can keep
 * reading a refusal with `.catch((error) => error)`.
 */
export const settled = async <T, E>(
  pending: Promise<Result<T, E>>,
): Promise<T> => {
  const result = await pending;
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};
