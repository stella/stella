import { Result } from "better-result";

import { buildVersionedApiUrl } from "@stll/api-contract";

import { env } from "@/env";
import { APIError, toAPIError } from "@/lib/api-error";
import { getAuthToken } from "@/lib/auth";

const REQUEST_TIMEOUT_MS = 10_000;

type OutlookApiRequestOptions<TResponse> = {
  body?: unknown;
  method?: "GET" | "POST" | "PUT";
  parse: (
    input: unknown,
  ) => { output: TResponse; success: true } | { success: false };
  path: `/${string}`;
  timeoutMs?: number;
};

const errorValue = (input: unknown): { message: string } | string => {
  if (typeof input === "string") {
    return input;
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "message" in input &&
    typeof input.message === "string"
  ) {
    return { message: input.message };
  }
  return { message: "API request failed" };
};

export const requestOutlookApi = async <TResponse>({
  body,
  method = "GET",
  parse,
  path,
  timeoutMs = REQUEST_TIMEOUT_MS,
}: OutlookApiRequestOptions<TResponse>): Promise<TResponse> => {
  const token = getAuthToken();
  const response = await fetch(buildVersionedApiUrl(env.apiBaseUrl, path), {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "omit",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    method,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const decoded = await Result.tryPromise({
    try: async () => await response.json(),
    catch: (cause) => cause,
  });
  if (Result.isError(decoded)) {
    throw new APIError({
      message: response.ok ? "Invalid API response" : "API request failed",
      status: response.ok ? 502 : response.status,
    });
  }
  if (!response.ok) {
    throw toAPIError({
      status: response.status,
      value: errorValue(decoded.value),
    });
  }

  const parsed = parse(decoded.value);
  if (!parsed.success) {
    throw new APIError({ message: "Invalid API response", status: 502 });
  }
  return parsed.output;
};
