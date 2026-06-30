import { Result } from "better-result";
import { asc, eq } from "drizzle-orm";

import { documentTypes } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const listDocumentTypes = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const organizationId = session.activeOrganizationId;

    const rows = yield* Result.await(
      safeDb((tx) =>
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
          .limit(LIMITS.documentTypesCount),
      ),
    );

    return Result.ok({ items: rows });
  },
);

export default listDocumentTypes;
