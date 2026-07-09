import { Result } from "better-result";
import { and, asc, count, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationAllowlistEntries, entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

/**
 * Anonymization allowlist endpoints.
 *
 * The blacklist (anonymization_blacklist_entries) catalogues
 * "always mask"; this allowlist catalogues "never mask". The
 * inspector's anonymization facet writes here when the user
 * marks a detection as a false positive. The detection pipeline
 * reads all entries that apply at request time and filters its
 * own output.
 *
 * Each entry has one of three scopes; the merge for a single
 * document is the union:
 *   - org-wide    (workspaceId NULL, entityId NULL)
 *   - workspace   (workspaceId set, entityId NULL)
 *   - document    (entityId set; workspaceId carried for RLS)
 *
 * Reads return ALL entries that apply to the requested document
 * so the facet can render the merged list and the pipeline can
 * filter in one pass.
 */

const readConfig = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  query: t.Object({
    entityId: t.Optional(tSafeId("entity")),
  }),
} satisfies HandlerConfig;

export const readWorkspaceAnonymizationAllowlist = createSafeHandler(
  readConfig,
  async function* ({ query, safeDb, workspaceId }) {
    const entityId = query.entityId ?? null;
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: anonymizationAllowlistEntries.id,
            scope: anonymizationAllowlistEntries.workspaceId,
            workspaceId: anonymizationAllowlistEntries.workspaceId,
            entityId: anonymizationAllowlistEntries.entityId,
            label: anonymizationAllowlistEntries.label,
            canonical: anonymizationAllowlistEntries.canonical,
            createdBy: anonymizationAllowlistEntries.createdBy,
            createdAt: anonymizationAllowlistEntries.createdAt,
          })
          .from(anonymizationAllowlistEntries)
          .where(
            or(
              // Org-wide
              and(
                isNull(anonymizationAllowlistEntries.workspaceId),
                isNull(anonymizationAllowlistEntries.entityId),
              ),
              // Workspace-wide for the current workspace
              and(
                eq(anonymizationAllowlistEntries.workspaceId, workspaceId),
                isNull(anonymizationAllowlistEntries.entityId),
              ),
              // Doc-scoped for the requested entity (only when entityId given)
              entityId === null
                ? undefined
                : and(
                    eq(anonymizationAllowlistEntries.workspaceId, workspaceId),
                    eq(anonymizationAllowlistEntries.entityId, entityId),
                  ),
            ),
          )
          // SAFETY: anonymization allowlist (never-mask overrides) must load fully to avoid over-masking; the workspace + doc-scoped set is bounded by the per-workspace write cap (LIMITS.anonymizationAllowlistEntriesPerWorkspace) enforced in createWorkspaceAnonymizationAllowlistEntry, and org-wide entries are not writable from this endpoint.
          // eslint-disable-next-line require-query-limit/require-query-limit
          .orderBy(asc(anonymizationAllowlistEntries.canonical)),
      ),
    );
    return Result.ok({ entries: rows });
  },
);

// Org-wide entries are deliberately NOT writable from this
// workspace endpoint. Creating or removing rows that apply to
// every workspace in the firm requires firm-admin context;
// otherwise any workspace editor could mask data org-wide. A
// dedicated org-settings endpoint with `organizationSettings`
// permissions will land alongside the org-wide management UI.
const SCOPE_VALUES = ["document", "workspace"] as const;

const createConfig = {
  permissions: { workspace: ["update"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  body: t.Object({
    canonical: t.String({ minLength: 1, maxLength: 512 }),
    label: t.String({ minLength: 1, maxLength: 64 }),
    scope: t.UnionEnum(SCOPE_VALUES),
    entityId: t.Optional(tSafeId("entity")),
  }),
} satisfies HandlerConfig;

export const createWorkspaceAnonymizationAllowlistEntry = createSafeHandler(
  createConfig,
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

const deleteConfig = {
  permissions: { workspace: ["update"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  params: t.Object({
    workspaceId: tSafeId("workspace"),
    entryId: tSafeId("anonymizationAllowlistEntry"),
  }),
} satisfies HandlerConfig;

export const deleteWorkspaceAnonymizationAllowlistEntry = createSafeHandler(
  deleteConfig,
  async function* ({
    params: { entryId },
    safeDb,
    workspaceId,
    recordAuditEvent,
  }) {
    yield* Result.await(
      safeDb(async (tx) => {
        // Scope the delete to rows that live inside the current
        // workspace. Org-wide rows (workspace_id IS NULL) are
        // intentionally NOT deletable from here — the org admin
        // endpoint owns those — so a workspace editor cannot
        // accidentally (or maliciously) remove a firm-wide entry
        // that the rest of the org relies on.
        const deleted = await tx
          .delete(anonymizationAllowlistEntries)
          .where(
            and(
              eq(anonymizationAllowlistEntries.id, entryId),
              eq(anonymizationAllowlistEntries.workspaceId, workspaceId),
            ),
          )
          .returning({
            id: anonymizationAllowlistEntries.id,
            canonical: anonymizationAllowlistEntries.canonical,
            label: anonymizationAllowlistEntries.label,
            entityId: anonymizationAllowlistEntries.entityId,
          });

        if (deleted.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            changes: {
              anonymizationAllowlist: {
                old: { removed: deleted.at(0) },
                new: null,
              },
            },
          });
        }
      }),
    );
    return Result.ok({ success: true as const });
  },
);
