import * as v from "valibot";

export const API_VALIDATION_ERROR_CODE = "validation" as const;

export type ApiValidationErrorValue = {
  expected?: string;
  found?: unknown;
  message?: string;
  on: string;
  property?: string;
  summary?: string;
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

const apiValidationErrorValueSchema = v.looseObject({
  expected: v.optional(v.string()),
  found: v.optional(v.unknown()),
  message: v.optional(v.string()),
  on: v.string(),
  property: v.optional(v.string()),
  summary: v.optional(v.string()),
  type: v.literal(API_VALIDATION_ERROR_CODE),
});

const apiErrorObjectValueSchema = v.looseObject({
  code: v.optional(v.string()),
  message: v.string(),
});

const apiErrorValueSchema = v.union([
  apiValidationErrorValueSchema,
  apiErrorObjectValueSchema,
  v.string(),
  v.null(),
  v.undefined(),
]);

export const parseApiErrorValue = (input: unknown): ApiErrorValue => {
  const result = v.safeParse(apiErrorValueSchema, input);
  return result.success ? result.output : null;
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
