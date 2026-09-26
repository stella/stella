import { Result } from "better-result";

import { isRecord } from "../type-guards";
import type { SourceFieldTarget, SourceRawParts } from "./ingestion-types";

/** A missing path stays missing, including a missing field in any array row. */
const readPath = (value: unknown, path: readonly string[]): unknown => {
  const [key, ...rest] = path;
  if (key === undefined) {
    return value;
  }
  if (key === "*") {
    return Array.isArray(value)
      ? value.map((row) => readPath(row, rest))
      : undefined;
  }
  return isRecord(value) && Object.hasOwn(value, key)
    ? readPath(value[key], rest)
    : undefined;
};

export const readSourceRawField = (
  parts: SourceRawParts,
  target: Extract<SourceFieldTarget, { type: "raw" }>,
): unknown => {
  const part = parts[target.part];
  if (part === undefined) {
    return undefined;
  }
  const parsed = Result.try({
    try: (): unknown => JSON.parse(part),
    catch: () => undefined,
  });
  return Result.isError(parsed)
    ? undefined
    : readPath(parsed.value, target.path);
};
