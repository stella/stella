import { TaggedError } from "better-result";

import { normalizeApiError } from "@stll/api-contract";
import type { ApiErrorInput } from "@stll/api-contract";

export class MobileAPIError extends TaggedError("MobileApiError")<{
  code?: string | undefined;
  details?: Record<string, unknown> | undefined;
  message: string;
  rawMessage?: string | undefined;
  status: number;
}>() {}

type EdenResponse<T> =
  | { data: T; error: null }
  | { data: null; error: ApiErrorInput };

export const unwrapEden = <T>(response: EdenResponse<T>): T => {
  if (!response.error) {
    return response.data;
  }

  const { code, details, rawMessage, status } = normalizeApiError(
    response.error,
  );
  throw new MobileAPIError({
    ...(code === undefined ? {} : { code }),
    ...(details === undefined ? {} : { details }),
    ...(rawMessage === undefined ? {} : { rawMessage }),
    message: "The request could not be completed.",
    status,
  });
};
