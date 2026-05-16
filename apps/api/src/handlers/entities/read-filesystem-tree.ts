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

const readFilesystemTreeBodySchema = t.Object({
  filters: t.Optional(t.Array(tViewFilterConditionSchema)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  fieldMode: t.Optional(t.UnionEnum(["full", "visible"])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
});

const config = {
  permissions: { workspace: ["read"] },
  body: readFilesystemTreeBodySchema,
} satisfies HandlerConfig;

type QueryEntities = typeof queryEntities;

export const createReadFilesystemTreeHandler = (
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
      const result = yield* Result.await(
        queryEntitiesImpl({
          safeDb,
          workspaceId,
          currentUserId: currentUser.id,
          currentOrganizationId: session.activeOrganizationId,
          filters: body.filters ?? [],
          sorts: body.sorts ?? [],
          ...(body.search !== undefined && { search: body.search }),
          offset: 0,
          limit: LIMITS.entitiesCount,
          fieldMode: body.fieldMode ?? "full",
          fieldIds: body.fieldIds ?? [],
          excludedKinds: ["task"],
          previewableForAi: false,
          includeTotalCount: false,
        }),
      );

      return Result.ok({
        entities: result.entities,
      });
    },
  );

const readFilesystemTree = createReadFilesystemTreeHandler();

export default readFilesystemTree;
