import { Result } from "better-result";

import { EntityCheckUnavailableError } from "./result.js";

// Field readers over a parsed XML element. A value of the wrong shape is a
// malformed answer, never a missing one: a reader that returned null for a
// garbled field could let an adverse record read as absent.

type FieldResult<T> = Result<T, EntityCheckUnavailableError>;

export const malformed = (message: string): EntityCheckUnavailableError =>
  new EntityCheckUnavailableError({
    reason: "malformed-response",
    detail: null,
    message,
  });

/** Trimmed text of an element or attribute; null when absent or blank. */
export const optionalText = (
  record: Record<string, unknown>,
  key: string,
): FieldResult<string | null> => {
  const value = record[key];
  if (value === undefined) {
    return Result.ok(null);
  }
  if (typeof value !== "string") {
    return Result.err(malformed(`Field ${key} is not text`));
  }
  const trimmed = value.trim();
  return Result.ok(trimmed.length === 0 ? null : trimmed);
};

export const requiredText = (
  record: Record<string, unknown>,
  key: string,
): FieldResult<string> =>
  optionalText(record, key).andThen((value) =>
    value === null
      ? Result.err(malformed(`Field ${key} is missing`))
      : Result.ok(value),
  );

// xsd:date values may carry a zone designator ("2016-05-09Z").
const XSD_DATE = /^(\d{4}-\d{2}-\d{2})(?:Z|[+-]\d{2}:\d{2})?$/u;

/** An xsd:date as a plain ISO calendar date. */
export const optionalXsdDate = (
  record: Record<string, unknown>,
  key: string,
): FieldResult<string | null> =>
  optionalText(record, key).andThen((value) => {
    if (value === null) {
      return Result.ok(null);
    }
    const date = XSD_DATE.exec(value)?.[1];
    return date === undefined
      ? Result.err(malformed(`Field ${key} is not a date`))
      : Result.ok(date);
  });
