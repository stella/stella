import { Result } from "better-result";
import { asc, eq } from "drizzle-orm";

import { documentTypes } from "@/api/db/schema";
import { ensureDefaultDocumentTypes } from "@/api/handlers/document-types/defaults";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "workspace_schema" },
} satisfies HandlerConfig;

const listDocumentTypes = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const organizationId = session.activeOrganizationId;

    const rows = yield* Result.await(
      safeDb(async (tx) => {
        // Lazily seed the starter taxonomy so an org provisioned before the
        // document-types table existed (or any org that never ran the dev seed)
        // still gets defaults on first read. Idempotent: existing rows conflict
        // on (organization_id, key) and are left untouched.
        await ensureDefaultDocumentTypes(organizationId, tx);
        return (
          tx
            .select({
              id: documentTypes.id,
              key: documentTypes.key,
              label: documentTypes.label,
              sortOrder: documentTypes.sortOrder,
            })
            .from(documentTypes)
            .where(eq(documentTypes.organizationId, organizationId))
            .orderBy(asc(documentTypes.sortOrder), asc(documentTypes.key))
            // Bounded org taxonomy (a few dozen entries, capped well under
            // `LIMITS.documentTypesCount`); a plain ordered array is returned
            // rather than a paginated `Page<T>` envelope.
            .limit(LIMITS.documentTypesCount)
        );
      }),
    );

    return Result.ok({ items: rows });
  },
);

export default listDocumentTypes;
