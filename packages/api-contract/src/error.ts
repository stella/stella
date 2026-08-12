export const API_VALIDATION_ERROR_CODE = "validation" as const;

/**
 * Machine-readable `code` on the 409 an optimistic-concurrency check returns
 * when the record moved under the caller. Shared so the handler that emits it
 * and the client that branches on it cannot drift apart.
 */
export const API_VERSION_CONFLICT_ERROR_CODE = "version_conflict" as const;

export type ApiValidationErrorValue = {
  expected?: string | undefined;
  found?: unknown;
  message?: string | undefined;
  on: string;
  property?: string | undefined;
  summary?: string | undefined;
  type: typeof API_VALIDATION_ERROR_CODE;
};

export type ApiErrorObjectValue = {
  code?: string | undefined;
  message: string;
  type?: never;
} & Record<string, unknown>;

export type ApiErrorValue =
  | ApiErrorObjectValue
  | ApiValidationErrorValue
  | string
  | null
  | undefined;

export type ApiErrorInput = {
  status: number;
  value: ApiErrorValue;
};

export type NormalizedApiError = {
  code?: string;
  details?: Record<string, unknown>;
  rawMessage?: string;
  status: number;
};

export const parseApiErrorValue = (input: unknown): ApiErrorValue => {
  if (input === null || input === undefined || typeof input === "string") {
    return input;
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  if (
    "type" in input &&
    input.type === API_VALIDATION_ERROR_CODE &&
    "on" in input &&
    typeof input.on === "string"
  ) {
    return {
      type: API_VALIDATION_ERROR_CODE,
      on: input.on,
      ...("expected" in input && typeof input.expected === "string"
        ? { expected: input.expected }
        : {}),
      ...("found" in input ? { found: input.found } : {}),
      ...("message" in input && typeof input.message === "string"
        ? { message: input.message }
        : {}),
      ...("property" in input && typeof input.property === "string"
        ? { property: input.property }
        : {}),
      ...("summary" in input && typeof input.summary === "string"
        ? { summary: input.summary }
        : {}),
    };
  }
  if (!("message" in input) || typeof input.message !== "string") {
    return null;
  }
  const result: ApiErrorObjectValue = { message: input.message };
  for (const [key, value] of Object.entries(input)) {
    if (key !== "code" && key !== "message" && key !== "type") {
      result[key] = value;
    }
  }
  if ("code" in input && typeof input.code === "string") {
    result.code = input.code;
  }
  return result;
};

const ERROR_TEXT_KEYS = new Set(["code", "message"]);

const pickErrorDetails = (
  value: ApiErrorObjectValue,
): Record<string, unknown> | undefined => {
  const entries = Object.entries(value).filter(
    ([key]) => !ERROR_TEXT_KEYS.has(key),
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

/** Normalizes transport errors without applying client-specific presentation. */
export const normalizeApiError = ({
  status,
  value,
}: ApiErrorInput): NormalizedApiError => {
  if (value === null || value === undefined) {
    return { status };
  }
  if (typeof value === "string") {
    return { rawMessage: value, status };
  }
  if (value.type === API_VALIDATION_ERROR_CODE) {
    return {
      code: API_VALIDATION_ERROR_CODE,
      rawMessage: JSON.stringify(value),
      status,
    };
  }

  const details = pickErrorDetails(value);
  return {
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(details === undefined ? {} : { details }),
    rawMessage: value.message,
    status,
  };
};
