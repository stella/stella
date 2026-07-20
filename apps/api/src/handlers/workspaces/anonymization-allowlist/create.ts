import { Result } from "better-result";
import { count, eq } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationAllowlistEntries, entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

// Org-wide entries are deliberately NOT writable from this
// workspace endpoint. Creating or removing rows that apply to
// every workspace in the firm requires firm-admin context;
// otherwise any workspace editor could mask data org-wide. A
// dedicated org-settings endpoint with `organizationSettings`
// permissions will land alongside the org-wide management UI.
const SCOPE_VALUES = ["document", "workspace"] as const;

const config = {
  permissions: { workspace: ["update"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  body: t.Object({
    canonical: t.String({ minLength: 1, maxLength: 512 }),
    label: t.String({ minLength: 1, maxLength: 64 }),
    scope: t.UnionEnum(SCOPE_VALUES),
    entityId: t.Optional(tSafeId("entity")),
  }),
} satisfies HandlerConfig;

const createWorkspaceAnonymizationAllowlistEntry = createSafeHandler(
  config,
  async function* ({
    body,
    safeDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const canonical = body.canonical.trim();
    if (canonical.length === 0) {
      return Result.ok({ inserted: 0 });
    }
    const scope = body.scope;
    if (scope === "document" && !body.entityId) {
      return Result.ok({ inserted: 0 });
    }
    const result = yield* Result.await(
      safeDb(async (tx) => {
        // Org-scoped RLS lets a workspace editor see entity IDs
        // outside their workspace, so doc-scope inserts MUST
        // confirm the entity actually belongs to the URL's
        // workspace. Without this, a caller could pin a doc-level
        // ignore on another workspace's file (the entity_canonical
        // unique index would then block the rightful owner from
        // ever toggling their own override).
        if (scope === "document" && body.entityId) {
          const owner = await tx
            .select({ workspaceId: entities.workspaceId })
            .from(entities)
            .where(eq(entities.id, body.entityId))
            .limit(1);
          if (owner.length === 0 || owner[0]?.workspaceId !== workspaceId) {
            return { type: "ok" as const, inserted: 0 };
          }
        }

        // Cap the per-workspace set (workspace + doc-scoped rows) so the
        // allowlist read stays bounded; org-wide rows are managed elsewhere.
        const existing = await tx
          .select({ value: count() })
          .from(anonymizationAllowlistEntries)
          .where(eq(anonymizationAllowlistEntries.workspaceId, workspaceId));
        if (
          (existing[0]?.value ?? 0) >=
          LIMITS.anonymizationAllowlistEntriesPerWorkspace
        ) {
          return { type: "limit-exceeded" as const };
        }

        const id = createSafeId<"anonymizationAllowlistEntry">();
        const values = {
          id,
          organizationId: session.activeOrganizationId,
          workspaceId,
          entityId: scope === "document" ? (body.entityId ?? null) : null,
          label: body.label,
          canonical,
          createdBy: user.id,
        };
        const inserted = await tx
          .insert(anonymizationAllowlistEntries)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: anonymizationAllowlistEntries.id });

        if (inserted.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            changes: {
              anonymizationAllowlist: {
                old: null,
                new: {
                  added: {
                    id,
                    scope,
                    canonical,
                    label: body.label,
                    entityId: values.entityId,
                  },
                },
              },
            },
          });
        }

        return { type: "ok" as const, inserted: inserted.length };
      }),
    );
    if (result.type === "limit-exceeded") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Workspace anonymization allowlist limit reached",
        }),
      );
    }
    return Result.ok({ inserted: result.inserted });
  },
);

export default createWorkspaceAnonymizationAllowlistEntry;
