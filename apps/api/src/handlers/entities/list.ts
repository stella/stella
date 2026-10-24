import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import {
  ENTITY_LIST_TEXT_MAX_LENGTH,
  queryEntities,
  queryMatterEntityCursorPage,
} from "@/api/lib/entities/query-entities";
import {
  entityQueryWindowBodySchema,
  entityReadPageBodySchema,
} from "@/api/lib/entities/query-window-schema";

const readEntitiesBodySchema = t.Object({
  ...entityReadPageBodySchema.properties,
  limit: {
    ...entityReadPageBodySchema.properties.limit,
    description: "Max entities to return",
  },
  ...t.Pick(entityQueryWindowBodySchema, ["excludedKinds", "previewableForAi"])
    .properties,
});

const config = {
  contract: "patch",
  description:
    "List a matter's documents, folders, and tasks as table rows with cursor " +
    "pagination and view filters, sorts, and search. Returns file metadata " +
    "by default; use visible fieldMode and fieldIds to select columns. " +
    `Text previews are capped at ${ENTITY_LIST_TEXT_MAX_LENGTH} characters and marked truncated. ` +
    "Use entities.get for complete values. excludedKinds drops kinds and " +
    "previewableForAi keeps documents whose content a model can read. " +
    "Use entities.filesystem-tree.get for folder pages.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "tool", name: "list_documents" },
  access: "read",
  body: readEntitiesBodySchema,
} satisfies WorkspaceHandlerConfig;

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
      const page = yield* Result.await(
        queryMatterEntityCursorPage({
          body,
          workspaceId,
          safeDb,
          currentUserId: currentUser.id,
          currentOrganizationId: session.activeOrganizationId,
          queryEntitiesImpl,
          excludedKinds: arrayOrEmpty(body.excludedKinds),
          previewableForAi: body.previewableForAi ?? false,
        }),
      );

      return Result.ok(page);
    },
  );

const readEntities = createReadEntitiesHandler();

export default readEntities;
