import type { Result } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { entityPath } from "@/state/matter-entities";

/** What the detail sheet shows; field values and file contents stay on the server. */
const entityDetailSchema = v.object({
  entityId: v.pipe(v.string(), v.minLength(1)),
  kind: v.string(),
  name: v.nullable(v.string()),
  currentVersionCreatedAt: v.nullish(v.string()),
  currentVersionReference: v.nullish(v.string()),
});

export type EntityDetail = v.InferOutput<typeof entityDetailSchema>;

/** One document, folder or task in a matter, as of its current version. */
export const readEntityDetail = async ({
  fetch,
  source,
  workspaceId,
  entityId,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly workspaceId: string;
  readonly entityId: string;
}): Promise<Result<EntityDetail, ApiError>> =>
  await requestApi({
    fetch,
    source,
    path: entityPath(workspaceId, entityId),
    schema: entityDetailSchema,
  });
