import { Result } from "better-result";
import { t } from "elysia";

import { queryEntities } from "@/api/handlers/entities/query-entities";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  tViewFilterConditionSchema,
  tViewSortSchema,
} from "@/api/lib/views-schema";

const readEntitiesBodySchema = t.Object({
  filters: t.Optional(t.Array(tViewFilterConditionSchema)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
  page: t.Optional(t.Integer({ minimum: 1 })),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  pageSize: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesPageSizeMax,
    }),
  ),
  fieldMode: t.Optional(t.UnionEnum(["full", "visible"])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
  previewableForAi: t.Optional(t.Boolean()),
});

const config = {
  permissions: { workspace: ["read"] },
  body: readEntitiesBodySchema,
} satisfies HandlerConfig;

type QueryEntities = typeof queryEntities;

export const createReadEntitiesHandler = (
  queryEntitiesImpl: QueryEntities = queryEntities,
) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      workspaceId,
      session,
      body,
      user: currentUser,
    }) {
      const page = body.page ?? 1;
      const pageSize = body.pageSize ?? LIMITS.entitiesPageSizeDefault;
      const result = yield* Result.await(
        queryEntitiesImpl({
          safeDb,
          workspaceId,
          currentUserId: currentUser.id,
          currentOrganizationId: session.activeOrganizationId,
          filters: body.filters ?? [],
          sorts: body.sorts ?? [],
          ...(body.search !== undefined && { search: body.search }),
          offset: (page - 1) * pageSize,
          limit: pageSize,
          fieldMode: body.fieldMode ?? "full",
          fieldIds: body.fieldIds ?? [],
          excludedKinds: [],
          previewableForAi: body.previewableForAi ?? false,
          includeTotalCount: true,
        }),
      );

      return Result.ok({
        entities: result.entities,
        totalCount: result.totalCount ?? 0,
        page,
        pageSize,
      });
    },
  );

const readEntities = createReadEntitiesHandler();

export default readEntities;
