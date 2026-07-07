import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { documentTypes } from "@/api/db/schema";
import { reorderDocumentTypesBodySchema } from "@/api/handlers/document-types/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "pending" },
  body: reorderDocumentTypesBodySchema,
} satisfies HandlerConfig;

// Persist `sortOrder` = position in `orderedIds`. Ids not owned by the org are
// ignored (never trusted from the client). Cosmetic ordering, so unlike the
// create/rename/delete mutations it records no audit event.
const reorderDocumentTypes = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body }) {
    const organizationId = session.activeOrganizationId;

    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — cosmetic sortOrder reordering only; no
        // governance-relevant field (key/label) changes, so no audit row.
        const owned = await tx
          .select({ id: documentTypes.id })
          .from(documentTypes)
          .where(eq(documentTypes.organizationId, organizationId));
        const ownedIds = new Set(owned.map((row) => row.id));

        const now = new Date();
        let sortOrder = 0;
        for (const id of body.orderedIds) {
          if (!ownedIds.has(id)) {
            continue;
          }
          // oxlint-disable-next-line no-await-in-loop -- sequential sortOrder writes inside one transaction
          await tx
            .update(documentTypes)
            .set({ sortOrder, updatedAt: now })
            .where(
              and(
                eq(documentTypes.id, id),
                eq(documentTypes.organizationId, organizationId),
              ),
            );
          sortOrder++;
        }
      }),
    );

    return Result.ok({});
  },
);

export default reorderDocumentTypes;
