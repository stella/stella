import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { readSearchPreview } from "@/api/lib/search/preview";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

export const searchPreviewBodySchema = t.Object({
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  resultId: t.String({ format: "uuid" }),
  type: t.UnionEnum(GLOBAL_SEARCH_RESULT_TYPES),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  access: "read",
  body: searchPreviewBodySchema,
} satisfies HandlerConfig;

const searchPreviewEndpoint = createSafeRootHandler(
  config,
  async function* ({ body, getActiveWorkspaceIds, session, user }) {
    const activeWorkspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    const preview = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readSearchPreview({
            query: body.query,
            resultId: body.resultId,
            type: body.type,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            accessibleWorkspaceIds: activeWorkspaceIds,
          }),
      ),
    );

    if (!preview) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Search result not found",
        }),
      );
    }

    return Result.ok(preview);
  },
);

export default searchPreviewEndpoint;
