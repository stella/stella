import { Result } from "better-result";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationAllowlistEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";

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
  body: t.Object({
    canonical: t.String({ minLength: 1, maxLength: 512 }),
    label: t.String({ minLength: 1, maxLength: 64 }),
    scope: t.UnionEnum(SCOPE_VALUES),
    entityId: t.Optional(tSafeId("entity")),
  }),
} satisfies HandlerConfig;

export const createWorkspaceAnonymizationAllowlistEntry = createSafeHandler(
  createConfig,
  async function* ({ body, safeDb, session, user, workspaceId }) {
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
        return { inserted: inserted.length };
      }),
    );
    return Result.ok(result);
  },
);

const deleteConfig = {
  permissions: { workspace: ["update"] },
  params: t.Object({
    workspaceId: tSafeId("workspace"),
    entryId: tSafeId("anonymizationAllowlistEntry"),
  }),
} satisfies HandlerConfig;

export const deleteWorkspaceAnonymizationAllowlistEntry = createSafeHandler(
  deleteConfig,
  async function* ({ params: { entryId }, safeDb, workspaceId }) {
    yield* Result.await(
      safeDb((tx) =>
        // Scope the delete to rows that live inside the current
        // workspace. Org-wide rows (workspace_id IS NULL) are
        // intentionally NOT deletable from here — the org admin
        // endpoint owns those — so a workspace editor cannot
        // accidentally (or maliciously) remove a firm-wide entry
        // that the rest of the org relies on.
        tx
          .delete(anonymizationAllowlistEntries)
          .where(
            and(
              eq(anonymizationAllowlistEntries.id, entryId),
              eq(anonymizationAllowlistEntries.workspaceId, workspaceId),
            ),
          ),
      ),
    );
    return Result.ok({ success: true as const });
  },
);
