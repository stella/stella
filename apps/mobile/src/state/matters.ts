import { Result } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError, Load } from "@/state/api-request";

/** The REST route the web app lists matters from; the API admits the app's token on it. */
const MATTERS_PATH = "/v1/workspaces";

/** Only what the list shows. */
const matterSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.string(),
  reference: v.nullish(v.string()),
  /** The matter's colour, as the web stores it; absent, one is hashed from the id. */
  color: v.nullish(v.string()),
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
      requestApi({
        fetch,
        path: MATTERS_PATH,
        schema: mattersResponseSchema,
        source,
      }),
    );
    return Result.ok(workspaces);
  });

/** The name of a new matter's documents column, as the web and MCP name it. */
const FILE_PROPERTY_NAME = "Documents";

const createdMatterSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Opens a matter under `name`. Without a client the server makes it a
 * personal matter, which only its creator sees until they share it.
 */
export const createMatter = async ({
  fetch,
  id,
  name,
  source,
}: {
  readonly fetch: Fetch;
  /**
   * The new matter's id, which the app names as the web does, so the
   * request repeated on a fresh token cannot open a second matter.
   */
  readonly id: string;
  readonly name: string;
  readonly source: AccessTokenSource;
}): Promise<Result<string, ApiError>> =>
  await Result.gen(async function* () {
    const created = yield* Result.await(
      requestApi({
        body: { filePropertyName: FILE_PROPERTY_NAME, id, name },
        fetch,
        method: "PUT",
        path: MATTERS_PATH,
        schema: createdMatterSchema,
        source,
      }),
    );
    return Result.ok(created.id);
  });
