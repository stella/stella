import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { SignedOutError, TokenError } from "@/connection/errors";
import { fetchWithTimeout } from "@/connection/http";
import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";

export class ApiRequestError extends TaggedError("ApiRequestError")<{
  message: string;
  status?: number | undefined;
  cause?: unknown;
}> {}

export type ApiError = ApiRequestError | SignedOutError | TokenError;

/** One load of a screen's data, stamped with when it returned so rows can say "2 hours ago" without reading the clock while rendering. */
export type Load<T> = {
  readonly loadedAt: number;
  readonly result: Result<T, ApiError>;
};

const requestJson = async <TSchema extends v.GenericSchema>(
  fetch: Fetch,
  url: string,
  accessToken: string,
  schema: TSchema,
): Promise<Result<v.InferOutput<TSchema>, ApiRequestError>> => {
  const answered = await Result.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(fetch, url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!response.ok) {
        return { status: response.status, json: undefined };
      }
      const json: unknown = await response.json();
      return { status: response.status, json };
    },
    catch: (cause) =>
      new ApiRequestError({ message: `The request to ${url} failed`, cause }),
  });
  if (Result.isError(answered)) {
    return Result.err(answered.error);
  }
  const { status, json } = answered.value;
  if (json === undefined) {
    return Result.err(
      new ApiRequestError({
        message: `The request to ${url} responded ${status}`,
        status,
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
 * A GET on the signed-in server, read through `schema`. The server is
 * validated against at runtime rather than trusted by type: a phone runs
 * whatever build it installed, so the server it talks to may be newer than
 * the app.
 */
export const getApiJson = async <TSchema extends v.GenericSchema>({
  fetch,
  path,
  schema,
  source,
}: {
  readonly fetch: Fetch;
  readonly path: string;
  readonly schema: TSchema;
  readonly source: AccessTokenSource;
}): Promise<Result<v.InferOutput<TSchema>, ApiError>> => {
  const url = `${source.session().serverUrl}${path}`;
  return await withAccessToken(
    source,
    async (token) => await requestJson(fetch, url, token, schema),
  );
};
