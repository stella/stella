import { Result } from "better-result";

import { buildVersionedApiUrl } from "@stll/api-contract";

import { env } from "@/env";
import { OutlookAPIError } from "@/lib/outlook-api-error";
import { type OutlookAuth, outlookAuth } from "@/lib/outlook-auth";

const REQUEST_TIMEOUT_MS = 10_000;
const UNAUTHORIZED = 401;

type ParseResponse<TResponse> = (
  input: unknown,
) => { output: TResponse; success: true } | { success: false };

type OutlookApiRequestOptions<TResponse> = {
  body?: unknown;
  method?: "GET" | "POST" | "PUT";
  parse: ParseResponse<TResponse>;
  path: `/${string}`;
  timeoutMs?: number;
};

type OutlookApiClientDependencies = {
  readonly auth: Pick<
    OutlookAuth,
    "forget" | "getAccessToken" | "refreshAfterUnauthorized"
  >;
  readonly baseUrl: string;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
};

const errorMessage = (input: unknown): string => {
  if (typeof input === "string") {
    return input;
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "message" in input &&
    typeof input.message === "string"
  ) {
    return input.message;
  }
  return "API request failed";
};

const signedOut = () =>
  new OutlookAPIError({ message: "Sign in to stella", status: UNAUTHORIZED });

export const createOutlookApiClient =
  ({ auth, baseUrl, fetch }: OutlookApiClientDependencies) =>
  async <TResponse>({
    body,
    method = "GET",
    parse,
    path,
    timeoutMs = REQUEST_TIMEOUT_MS,
  }: OutlookApiRequestOptions<TResponse>): Promise<TResponse> => {
    const send = async (token: string) =>
      await fetch(buildVersionedApiUrl(baseUrl, path), {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: "omit",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        method,
        signal: AbortSignal.timeout(timeoutMs),
      });

    const token = await auth.getAccessToken();
    if (token === null) {
      throw signedOut();
    }
    let response = await send(token);
    if (response.status === UNAUTHORIZED) {
      // One refresh, then one retry; a second refusal ends the session.
      const refreshed = await auth.refreshAfterUnauthorized(token);
      if (refreshed === null) {
        throw signedOut();
      }
      response = await send(refreshed);
      if (response.status === UNAUTHORIZED) {
        auth.forget();
        throw signedOut();
      }
    }

    const decoded = await Result.tryPromise(
      async (): Promise<unknown> => await response.json(),
    );
    if (!response.ok) {
      throw new OutlookAPIError({
        message: Result.isOk(decoded)
          ? errorMessage(decoded.value)
          : "API request failed",
        status: response.status,
      });
    }
    if (Result.isError(decoded)) {
      throw new OutlookAPIError({
        message: "Invalid API response",
        status: 502,
      });
    }
    const parsed = parse(decoded.value);
    if (!parsed.success) {
      throw new OutlookAPIError({
        message: "Invalid API response",
        status: 502,
      });
    }
    return parsed.output;
  };

let defaultClient: ReturnType<typeof createOutlookApiClient> | null = null;

/** A JSON request to the stella API with the task pane's access token. */
export const requestOutlookApi = async <TResponse>(
  options: OutlookApiRequestOptions<TResponse>,
): Promise<TResponse> => {
  defaultClient ??= createOutlookApiClient({
    auth: outlookAuth(),
    baseUrl: env.apiFetchBase,
    fetch: async (input, init) => await fetch(input, init),
  });
  return await defaultClient(options);
};
