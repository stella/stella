import { t } from "elysia";

import { renameEntityHandler } from "@/api/handlers/entities/rename-operation";
import { entityRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const renameEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
  name: t.String({
    minLength: 1,
    maxLength: LIMITS.entityNameMaxLength,
  }),
});

const config = {
  description:
    "Rename one document, folder, or task in a matter. For a document the " +
    "stored file name is renamed to match, so the table's file column stays " +
    "in step with the entity name. A read-only entity is refused.",
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityRealtimeUpdates,
  mcp: { type: "covered", by: "save_document" },
  body: renameEntityBodySchema,
} satisfies WorkspaceHandlerConfig;

const renameEntity = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    return yield* renameEntityHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default renameEntity;
