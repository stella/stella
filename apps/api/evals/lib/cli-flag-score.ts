import { Result } from "better-result";
import { isDeepStrictEqual } from "node:util";

const parseCliInputObject = (
  value: string | null | undefined,
): object | null => {
  if (typeof value !== "string") {
    return null;
  }
  const result = Result.try(() => JSON.parse(value));
  if (Result.isError(result)) {
    return null;
  }
  const parsed: unknown = result.value;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : null;
};

export const sameCliFlagValue = ({
  actual,
  expected,
  flagName,
}: {
  actual: string | null | undefined;
  expected: string;
  flagName: string;
}): boolean => {
  if (flagName !== "input") {
    return actual === expected;
  }
  const actualInput = parseCliInputObject(actual);
  const expectedInput = parseCliInputObject(expected);
  return (
    actualInput !== null &&
    expectedInput !== null &&
    isDeepStrictEqual(actualInput, expectedInput)
  );
};
