import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { SignedOutError, TokenError } from "@/connection/errors";
import { fetchWithTimeout } from "@/connection/http";
import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";

export class ApiRequestError extends TaggedError("ApiRequestError")<{
  message: string;
  status?: number | undefined;
  /**
   * The token lacks a scope the route needs (RFC 6750 §3.1), as a session
   * from before the app asked for that scope does; signing in again grants it.
   */
  insufficientScope?: boolean | undefined;
  /** What the server said was wrong, and how to fix it, when it said so. */
  detail?: string | undefined;
  cause?: unknown;
}> {}

const refusalSchema = v.object({
  message: v.optional(v.string()),
  hint: v.optional(v.string()),
});

/** The server's own words for a refusal, from its `{ message, hint }` body. */
const refusalDetail = (json: unknown): string | undefined => {
  const parsed = v.safeParse(refusalSchema, json);
  if (!parsed.success) {
    return undefined;
  }
  const words = [parsed.output.message, parsed.output.hint].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return words.length === 0 ? undefined : words.join(" ");
};

/** Whether `error` is the server asking for a scope this sign-in never granted. */
export const needsConsent = (error: ApiError): boolean =>
  error._tag === "ApiRequestError" && error.insufficientScope === true;

export type ApiError = ApiRequestError | SignedOutError | TokenError;

/** One load of a screen's data, stamped with when it returned so rows can say "2 hours ago" without reading the clock while rendering. */
export type Load<T> = {
  readonly loadedAt: number;
  readonly result: Result<T, ApiError>;
};

type ApiRequest<TSchema extends v.GenericSchema> = {
  readonly path: string;
  readonly schema: TSchema;
  /** A JSON body makes the request a POST, unless `method` says otherwise. */
  readonly body?: unknown;
  /** Without one, a request with a body is a POST and one without a GET. */
  readonly method?: "POST" | "PUT" | "PATCH" | "DELETE";
};

const requestJson = async <TSchema extends v.GenericSchema>(
  fetch: Fetch,
  url: string,
  /** Null for a public route, which answers anyone. */
  accessToken: string | null,
  {
    schema,
    body,
    method = body === undefined ? "GET" : "POST",
  }: Omit<ApiRequest<TSchema>, "path">,
): Promise<Result<v.InferOutput<TSchema>, ApiRequestError>> => {
  const answered = await Result.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(fetch, url, {
        headers: {
          Accept: "application/json",
          ...(accessToken === null
            ? {}
            : { Authorization: `Bearer ${accessToken}` }),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const insufficientScope =
          response.headers
            .get("WWW-Authenticate")
            ?.includes('error="insufficient_scope"') === true;
        const refusal: unknown = await response.json().catch(() => undefined);
        return {
          status: response.status,
          json: undefined,
          insufficientScope,
          detail: refusalDetail(refusal),
        };
      }
      const json: unknown = await response.json();
      return {
        status: response.status,
        json,
        insufficientScope: false,
        detail: undefined,
      };
    },
    catch: (cause) =>
      new ApiRequestError({ message: `The request to ${url} failed`, cause }),
  });
  if (Result.isError(answered)) {
    return Result.err(answered.error);
  }
  const { status, json, insufficientScope, detail } = answered.value;
  if (json === undefined) {
    return Result.err(
      new ApiRequestError({
        message: `The request to ${url} responded ${status}`,
        status,
        insufficientScope,
        detail,
      }),
    );
  }
  const parsed = v.safeParse(schema, json);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new ApiRequestError({
          message: `The request to ${url} answered an unexpected body`,
          cause: new v.ValiError(parsed.issues),
        }),
      );
};

/**
 * Runs `request` on a current access token. A rejected token is spent
 * whatever its clock says, so it is dropped and the request runs once more
 * on a fresh one; a second rejection is the server's answer.
 */
export const withAccessToken = async <T>(
  source: AccessTokenSource,
  request: (accessToken: string) => Promise<Result<T, ApiRequestError>>,
): Promise<Result<T, ApiError>> =>
  await Result.gen(async function* () {
    const token = yield* Result.await(source.accessToken());
    const first = await request(token);
    if (Result.isOk(first) || first.error.status !== 401) {
      return first;
    }
    source.invalidate();
    const fresh = yield* Result.await(source.accessToken());
    return await request(fresh);
  });

/**
 * One JSON request to the signed-in server, read through `schema`. The
 * server is validated against at runtime rather than trusted by type: a
 * phone runs whatever build it installed, so the server it talks to may be
 * newer than the app.
 */
export const requestApi = async <TSchema extends v.GenericSchema>({
  fetch,
  source,
  path,
  ...request
}: ApiRequest<TSchema> & {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<v.InferOutput<TSchema>, ApiError>> => {
  const url = `${source.session().serverUrl}${path}`;
  return await withAccessToken(
    source,
    async (token) => await requestJson(fetch, url, token, request),
  );
};

/**
 * One JSON request to a public route of the signed-in server, such as the
 * case-law corpus, which answers without a token. Sending none keeps the
 * read working whatever state the session's tokens are in.
 */
export const requestPublicApi = async <TSchema extends v.GenericSchema>({
  fetch,
  path,
  serverUrl,
  ...request
}: ApiRequest<TSchema> & {
  readonly fetch: Fetch;
  readonly serverUrl: string;
}): Promise<Result<v.InferOutput<TSchema>, ApiRequestError>> =>
  await requestJson(fetch, `${serverUrl}${path}`, null, request);
