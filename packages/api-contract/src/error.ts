export const API_VALIDATION_ERROR_CODE = "validation" as const;

export type ApiValidationErrorValue = {
  expected?: string;
  found?: unknown;
  message?: string;
  on: string;
  property?: string;
  summary?: string;
  type: "validation";
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
  if (value.type === "validation") {
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
