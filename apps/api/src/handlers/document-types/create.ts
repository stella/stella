import { panic, Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import { documentTypes } from "@/api/db/schema";
import {
  slugifyDocumentTypeKey,
  uniqueDocumentTypeKey,
} from "@/api/handlers/document-types/keys";
import { createDocumentTypeBodySchema } from "@/api/handlers/document-types/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: createDocumentTypeBodySchema,
} satisfies HandlerConfig;

const createDocumentType = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const label = body.label.trim();
    if (label.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "Label is required" }),
      );
    }

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        // Serialize concurrent creates for the same org so the count check
        // below cannot race past the configured limit (the read + insert are
        // otherwise not atomic).
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`,
        );
        const existing = await tx
          .select({
            key: documentTypes.key,
            sortOrder: documentTypes.sortOrder,
          })
          .from(documentTypes)
          .where(eq(documentTypes.organizationId, organizationId));

        if (existing.length >= LIMITS.documentTypesCount) {
          return { limitReached: true } as const;
        }

        const key = uniqueDocumentTypeKey(
          slugifyDocumentTypeKey(label),
          new Set(existing.map((row) => row.key)),
        );
        // Append after the current tail so a new type lands last.
        let maxSortOrder = -1;
        for (const row of existing) {
          if (row.sortOrder > maxSortOrder) {
            maxSortOrder = row.sortOrder;
          }
        }
        const sortOrder = maxSortOrder + 1;

        const row = (
          await tx
            .insert(documentTypes)
            .values({ organizationId, key, label, sortOrder })
            .returning({
              id: documentTypes.id,
              key: documentTypes.key,
              label: documentTypes.label,
              sortOrder: documentTypes.sortOrder,
            })
        ).at(0);
        if (!row) {
          panic("Failed to insert document type");
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_TYPE,
          resourceId: row.id,
          changes: {
            created: { old: null, new: { key: row.key, label: row.label } },
          },
        });

        return { row } as const;
      }),
    );

    if ("limitReached" in outcome) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Document type limit reached (max ${String(LIMITS.documentTypesCount)})`,
        }),
      );
    }

    return Result.ok(outcome.row);
  },
);

export default createDocumentType;
