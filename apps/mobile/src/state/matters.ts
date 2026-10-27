import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { SignedOutError, TokenError } from "@/connection/errors";
import { fetchWithTimeout } from "@/connection/http";
import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";

/** The REST route the web app lists matters from; the API admits the app's token on it. */
const MATTERS_PATH = "/v1/workspaces";

/**
 * Only what the list shows. The server is validated against at runtime rather
 * than trusted by type: a phone runs whatever build it installed, so the
 * server it talks to may be newer than the app.
 */
const matterSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.string(),
  reference: v.nullish(v.string()),
  lastActivityAt: v.nullish(v.string()),
  client: v.nullish(v.object({ displayName: v.string() })),
});

const mattersResponseSchema = v.object({ workspaces: v.array(matterSchema) });

export type MatterSummary = v.InferOutput<typeof matterSchema>;

class MattersRequestError extends TaggedError("MattersRequestError")<{
  message: string;
  status?: number | undefined;
  cause?: unknown;
}> {}

export type MattersError = MattersRequestError | SignedOutError | TokenError;

/** One load of the list, stamped with when it returned so rows can say "2 hours ago" without reading the clock while rendering. */
export type MattersLoad = {
  readonly loadedAt: number;
  readonly result: Result<MatterSummary[], MattersError>;
};

const requestMatters = async (
  fetch: Fetch,
  serverUrl: string,
  accessToken: string,
): Promise<Result<MatterSummary[], MattersRequestError>> => {
  const answered = await Result.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(
        fetch,
        `${serverUrl}${MATTERS_PATH}`,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
      if (!response.ok) {
        return { status: response.status, json: undefined };
      }
      const json: unknown = await response.json();
      return { status: response.status, json };
    },
    catch: (cause) =>
      new MattersRequestError({ message: "The matters request failed", cause }),
  });
  if (Result.isError(answered)) {
    return Result.err(answered.error);
  }
  const { status, json } = answered.value;
  if (json === undefined) {
    return Result.err(
      new MattersRequestError({
        message: `The matters request responded ${status}`,
        status,
      }),
    );
  }
  const matters = v.safeParse(mattersResponseSchema, json);
  return matters.success
    ? Result.ok(matters.output.workspaces)
    : Result.err(
        new MattersRequestError({
          message: "The matters request answered an unexpected body",
          cause: new v.ValiError(matters.issues),
        }),
      );
};

/**
 * The person's matters, most recently active first. A rejected token is
 * spent whatever its clock says, so it is dropped and the request runs once
 * more on a fresh one; a second rejection is the server's answer.
 */
export const listMatters = async ({
  fetch,
  source,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<MatterSummary[], MattersError>> =>
  await Result.gen(async function* () {
    const { serverUrl } = source.session();
    const token = yield* Result.await(source.accessToken());
    const first = await requestMatters(fetch, serverUrl, token);
    if (Result.isOk(first) || first.error.status !== 401) {
      return first;
    }
    source.invalidate();
    const fresh = yield* Result.await(source.accessToken());
    return await requestMatters(fetch, serverUrl, fresh);
  });
