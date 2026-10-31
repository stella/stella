import { Result } from "better-result";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db/safe-db";
import { searchProvenanceError } from "@/api/handlers/search/provenance-error";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { readSearchPreview } from "@/api/lib/search/preview";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

export const searchPreviewBodySchema = v.object({
  query: v.pipe(v.string(), v.maxLength(LIMITS.searchQueryMaxLength)),
  resultId: v.pipe(v.string(), v.uuid()),
  type: v.picklist(GLOBAL_SEARCH_RESULT_TYPES),
});

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "search_ui" },
  access: "read",
  body: searchPreviewBodySchema,
} satisfies HandlerConfig;

type SearchPreviewHandlerOptions = {
  query: Parameters<typeof readSearchPreview>[0];
  scopedDb: ScopedDb;
  readPreview?: typeof readSearchPreview;
};

export const searchPreviewHandler = async ({
  query,
  scopedDb,
  readPreview = readSearchPreview,
}: SearchPreviewHandlerOptions) => {
  const preview = await readPreview(query, scopedDb);
  if (preview.isErr()) {
    return Result.err(searchProvenanceError(preview.error));
  }
  if (preview.value === null) {
    return Result.err(
      new HandlerError({ status: 404, message: "Search result not found" }),
    );
  }
  return Result.ok(preview.value);
};

const searchPreviewEndpoint = createSafeRootHandler(
  config,
  async function* ({ body, getActiveWorkspaceIds, scopedDb, session, user }) {
    const activeWorkspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    return yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchPreviewHandler({
            query: {
              query: body.query,
              resultId: body.resultId,
              type: body.type,
              organizationId: session.activeOrganizationId,
              userId: user.id,
              accessibleWorkspaceIds: activeWorkspaceIds,
            },
            scopedDb,
          }),
      ),
    );
  },
);

export default searchPreviewEndpoint;
