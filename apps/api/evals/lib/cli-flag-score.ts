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

/**
 * The same JSON with every array sorted by its members' JSON form, so two
 * payloads that differ only in the order of a set compare equal. Opt-in per
 * expectation: an ordered list must stay order-sensitive.
 */
const withSortedArrays = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value
      .map(withSortedArrays)
      .toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        withSortedArrays(member),
      ]),
    );
  }
  return value;
};

export const sameCliFlagValue = ({
  actual,
  expected,
  flagName,
  unordered = false,
}: {
  actual: string | null | undefined;
  expected: string;
  flagName: string;
  /** Compare the `--input` payload's arrays as sets rather than sequences. */
  unordered?: boolean;
}): boolean => {
  if (flagName !== "input") {
    return actual === expected;
  }
  const actualInput = parseCliInputObject(actual);
  const expectedInput = parseCliInputObject(expected);
  if (actualInput === null || expectedInput === null) {
    return false;
  }
  return unordered
    ? isDeepStrictEqual(
        withSortedArrays(actualInput),
        withSortedArrays(expectedInput),
      )
    : isDeepStrictEqual(actualInput, expectedInput);
};
