import { Result } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { getApiJson } from "@/state/api-request";
import type { ApiError, Load } from "@/state/api-request";

/** The REST route the web app lists matters from; the API admits the app's token on it. */
const MATTERS_PATH = "/v1/workspaces";

/** Only what the list shows. */
const matterSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.string(),
  reference: v.nullish(v.string()),
  lastActivityAt: v.nullish(v.string()),
  client: v.nullish(v.object({ displayName: v.string() })),
});

const mattersResponseSchema = v.object({ workspaces: v.array(matterSchema) });

export type MatterSummary = v.InferOutput<typeof matterSchema>;

export type MattersLoad = Load<MatterSummary[]>;

/** The person's matters, most recently active first. */
export const listMatters = async ({
  fetch,
  source,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<MatterSummary[], ApiError>> =>
  await Result.gen(async function* () {
    const { workspaces } = yield* Result.await(
      getApiJson({
        fetch,
        path: MATTERS_PATH,
        schema: mattersResponseSchema,
        source,
      }),
    );
    return Result.ok(workspaces);
  });
