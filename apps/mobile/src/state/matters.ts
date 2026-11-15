import { Result } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError, Load } from "@/state/api-request";

/** The REST route the web app lists matters from; the API admits the app's token on it. */
const MATTERS_PATH = "/v1/workspaces";

/** The organization's people a matter can be shared with. */
const MEMBER_CANDIDATES_PATH = "/v1/workspaces/member-candidates";

/** Only what the list shows. */
const matterSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.string(),
  reference: v.nullish(v.string()),
  /** The matter's colour, as the web stores it; absent, one is hashed from the id. */
  color: v.nullish(v.string()),
  lastActivityAt: v.nullish(v.string()),
  client: v.nullish(
    v.object({
      id: v.pipe(v.string(), v.minLength(1)),
      displayName: v.string(),
    }),
  ),
});

const mattersResponseSchema = v.object({ workspaces: v.array(matterSchema) });

export type MatterSummary = v.InferOutput<typeof matterSchema>;

export type MattersLoad = Load<MatterSummary[]>;

/**
 * The person's matters, most recently active first: the active ones, or with
 * `status` the archived ones, as the web's archived filter lists them.
 */
export const listMatters = async ({
  fetch,
  source,
  status,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly status?: "archived";
}): Promise<Result<MatterSummary[], ApiError>> =>
  await Result.gen(async function* () {
    const { workspaces } = yield* Result.await(
      requestApi({
        fetch,
        path:
          status === undefined
            ? MATTERS_PATH
            : `${MATTERS_PATH}?${new URLSearchParams({ status }).toString()}`,
        schema: mattersResponseSchema,
        source,
      }),
    );
    return Result.ok(workspaces);
  });

const memberCandidateSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1)),
  name: v.string(),
  email: v.string(),
  image: v.nullish(v.string()),
});

export type MemberCandidate = v.InferOutput<typeof memberCandidateSchema>;

const memberCandidatesResponseSchema = v.object({
  members: v.array(memberCandidateSchema),
});

/** Everyone in the person's organization, by name: who a matter can go to. */
export const listMemberCandidates = async ({
  fetch,
  source,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<MemberCandidate[], ApiError>> =>
  await Result.gen(async function* () {
    const { members } = yield* Result.await(
      requestApi({
        fetch,
        path: MEMBER_CANDIDATES_PATH,
        schema: memberCandidatesResponseSchema,
        source,
      }),
    );
    return Result.ok(members);
  });

/**
 * Who a new matter is shared with besides its creator, who is always on it.
 * Without a client the matter is personal, visible to the creator alone,
 * and the server takes no one else, so nobody is sent.
 */
export const newMatterMembers = ({
  chosen,
  clientId,
  creatorId,
}: {
  readonly chosen: ReadonlySet<string>;
  readonly clientId: string | null;
  readonly creatorId: string | undefined;
}): string[] =>
  clientId === null ? [] : [...chosen].filter((userId) => userId !== creatorId);

/** The name of a new matter's documents column, as the web and MCP name it. */
const FILE_PROPERTY_NAME = "Documents";

const createdMatterSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Opens a matter under `name`. With a client it is shared with
 * `memberUserIds` as well as its creator; without one the server makes it a
 * personal matter, which only its creator sees until they share it. Its
 * number comes from the organization's numbering, as on the web.
 */
export const createMatter = async ({
  clientId,
  fetch,
  id,
  memberUserIds,
  name,
  source,
}: {
  /** The contact the matter is for; null opens a personal matter. */
  readonly clientId: string | null;
  readonly fetch: Fetch;
  /**
   * The new matter's id, which the app names as the web does, so the
   * request repeated on a fresh token cannot open a second matter.
   */
  readonly id: string;
  readonly memberUserIds: readonly string[];
  readonly name: string;
  readonly source: AccessTokenSource;
}): Promise<Result<string, ApiError>> =>
  await Result.gen(async function* () {
    const created = yield* Result.await(
      requestApi({
        body: {
          filePropertyName: FILE_PROPERTY_NAME,
          id,
          name,
          ...(clientId === null
            ? {}
            : {
                clientId,
                ...(memberUserIds.length === 0 ? {} : { memberUserIds }),
              }),
        },
        fetch,
        method: "PUT",
        path: MATTERS_PATH,
        schema: createdMatterSchema,
        source,
      }),
    );
    return Result.ok(created.id);
  });
