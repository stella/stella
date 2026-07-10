import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import { documentTypes } from "@/api/db/schema";
import { reorderDocumentTypesBodySchema } from "@/api/handlers/document-types/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
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
        const orderedOwnedIds = body.orderedIds.filter((id) =>
          ownedIds.has(id),
        );

        if (orderedOwnedIds.length === 0) {
          return;
        }

        // Single batched write: one CASE expression sets every row's
        // sortOrder in one UPDATE, instead of one query per id (was N+1
        // for an N-row reorder).
        const cases = orderedOwnedIds.map(
          (id, index) =>
            sql`when ${documentTypes.id} = ${id} then ${index}::integer`,
        );
        const now = new Date();
        await tx
          .update(documentTypes)
          .set({
            sortOrder: sql`(case ${sql.join(cases, sql` `)} end)`,
            updatedAt: now,
          })
          .where(
            and(
              eq(documentTypes.organizationId, organizationId),
              inArray(documentTypes.id, orderedOwnedIds),
            ),
          );
      }),
    );

    return Result.ok({});
  },
);

export default reorderDocumentTypes;
