import { panic } from "better-result";

export const positiveDedicatedTimeoutMilliseconds = (
  value: number,
  name: string,
): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return panic(`${name} must be a finite positive millisecond budget`);
  }
  return value;
};

/** A LOCAL budget on a caller-owned dedicated transaction; never pool-clamped. */
export const setDedicatedStatementTimeout = async (
  execute: (statement: string) => Promise<unknown>,
  requestedMs: number,
): Promise<void> => {
  const budget = positiveDedicatedTimeoutMilliseconds(
    requestedMs,
    "statementTimeout",
  );
  await execute(`SET LOCAL statement_timeout = '${budget}ms'`);
};
