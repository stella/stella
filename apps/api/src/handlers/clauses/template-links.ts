import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { templateClauses } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

// ── Schemas ─────────────────────────────────────────

export const linkClauseBodySchema = t.Object({
  clauseId: tSafeId("clause"),
  variantId: t.Optional(tSafeId("clauseVariant")),
  slotName: t.Optional(t.String({ maxLength: 128 })),
});

type LinkClauseBody = Static<typeof linkClauseBodySchema>;

// ── Helpers ─────────────────────────────────────────

const verifyTemplateOwnership = async (
  scopedDb: ScopedDb,
  templateId: SafeId<"template">,
  organizationId: SafeId<"organization">,
) => {
  const template = await scopedDb((tx) =>
    tx.query.templates.findFirst({
      where: {
        id: { eq: templateId },
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  return template;
};

type OutdatedCheckLink = {
  clause: { currentVersion: number } | null;
  clauseVersion: { version: number } | null;
};

/** A link is outdated when it pins a version older than the
 *  clause's current one. Deleted clauses are never outdated. */
export const isOutdatedLink = (link: OutdatedCheckLink): boolean =>
  link.clause !== null &&
  link.clauseVersion !== null &&
  link.clauseVersion.version < link.clause.currentVersion;

type VariantTombstoneLink = {
  clauseVariantId: SafeId<"clauseVariant"> | null;
  clauseVariantLabel: string | null;
};

/** The linked variant was deleted: the FK nulled `clauseVariantId`
 *  but the label snapshot taken at link time remains. */
export const isVariantDeleted = (link: VariantTombstoneLink): boolean =>
  link.clauseVariantId === null && link.clauseVariantLabel !== null;

// ── List linked clauses ─────────────────────────────

type ListTemplateClausesProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
};

export const listTemplateClausesHandler = async ({
  scopedDb,
  organizationId,
  templateId,
}: ListTemplateClausesProps) => {
  const template = await verifyTemplateOwnership(
    scopedDb,
    templateId,
    organizationId,
  );

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const links = await scopedDb((tx) =>
    tx.query.templateClauses.findMany({
      where: {
        templateId: { eq: templateId },
        organizationId: { eq: organizationId },
      },
      columns: {
        id: true,
        clauseId: true,
        clauseVariantId: true,
        clauseVariantLabel: true,
        clauseVersionId: true,
        slotName: true,
        sortOrder: true,
        insertedAt: true,
      },
      with: {
        clause: {
          columns: {
            id: true,
            title: true,
            currentVersion: true,
          },
        },
        clauseVersion: {
          columns: {
            id: true,
            version: true,
          },
        },
        clauseVariant: {
          columns: {
            id: true,
            label: true,
          },
        },
      },
      orderBy: { sortOrder: "asc" },
      limit: LIMITS.templateClausesPerTemplate,
    }),
  );

  return {
    links: links.map((link) => ({
      id: link.id,
      clauseId: link.clauseId,
      clauseVariantId: link.clauseVariantId,
      clauseVariantLabel: link.clauseVariantLabel,
      clauseVersionId: link.clauseVersionId,
      slotName: link.slotName,
      sortOrder: link.sortOrder,
      insertedAt: link.insertedAt,
      clause: link.clause,
      clauseVersion: link.clauseVersion,
      clauseVariant: link.clauseVariant,
      isOutdated: isOutdatedLink(link),
      variantDeleted: isVariantDeleted(link),
    })),
  };
};

// ── Link clause to template ─────────────────────────

type LinkClauseProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  body: LinkClauseBody;
  recordAuditEvent: AuditRecorder;
};

export const linkClauseHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  body,
  recordAuditEvent,
}: LinkClauseProps) => {
  const template = await verifyTemplateOwnership(
    scopedDb,
    templateId,
    organizationId,
  );

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  // Verify clause belongs to same organization
  const clause = await scopedDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: { eq: body.clauseId },
        organizationId: { eq: organizationId },
      },
      columns: { id: true, currentVersion: true },
    }),
  );

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  // Verify variant if specified; snapshot its label so a later
  // variant deletion leaves a detectable tombstone on the link.
  let variantLabel: string | null = null;
  if (body.variantId) {
    const variant = await scopedDb((tx) =>
      tx.query.clauseVariants.findFirst({
        where: {
          id: { eq: body.variantId },
          clauseId: { eq: body.clauseId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, label: true },
      }),
    );

    if (!variant) {
      return status(404, {
        message: "Variant not found",
      });
    }

    variantLabel = variant.label;
  }

  // Find the current version snapshot
  const currentVersion = await scopedDb((tx) =>
    tx.query.clauseVersions.findFirst({
      where: {
        clauseId: { eq: body.clauseId },
        version: clause.currentVersion,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  // Advisory lock + count + insert in one transaction to
  // prevent TOCTOU race on the limit and duplicate sortOrder.
  const result = await scopedDb(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
    );

    const linkCount = await tx.$count(
      templateClauses,
      eq(templateClauses.templateId, templateId),
    );

    if (linkCount >= LIMITS.templateClausesPerTemplate) {
      return null;
    }

    const [row] = await tx
      .insert(templateClauses)
      .values({
        id: createSafeId<"templateClause">(),
        organizationId,
        templateId,
        clauseId: body.clauseId,
        clauseVariantId: body.variantId ?? null,
        clauseVariantLabel: variantLabel,
        clauseVersionId: currentVersion?.id ?? null,
        slotName: body.slotName ?? null,
        sortOrder: linkCount,
      })
      .returning({
        id: templateClauses.id,
        clauseId: templateClauses.clauseId,
        clauseVariantId: templateClauses.clauseVariantId,
        clauseVersionId: templateClauses.clauseVersionId,
        slotName: templateClauses.slotName,
        sortOrder: templateClauses.sortOrder,
        insertedAt: templateClauses.insertedAt,
      });

    if (row) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_TEMPLATE_LINK,
        resourceId: row.id,
        changes: {
          created: {
            old: null,
            new: {
              templateId,
              clauseId: row.clauseId,
              clauseVariantId: row.clauseVariantId,
              clauseVersionId: row.clauseVersionId,
              slotName: row.slotName,
            },
          },
        },
      });
    }

    return row;
  });

  if (!result) {
    return status(400, {
      message: "Template clause limit reached",
    });
  }

  return result;
};

// ── Unlink ──────────────────────────────────────────

type UnlinkClauseProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  linkId: SafeId<"templateClause">;
  recordAuditEvent: AuditRecorder;
};

export const unlinkClauseHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  linkId,
  recordAuditEvent,
}: UnlinkClauseProps) => {
  const template = await verifyTemplateOwnership(
    scopedDb,
    templateId,
    organizationId,
  );

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const existing = await scopedDb((tx) =>
    tx.query.templateClauses.findFirst({
      where: {
        id: { eq: linkId },
        templateId: { eq: templateId },
        organizationId: { eq: organizationId },
      },
      columns: {
        id: true,
        clauseId: true,
        clauseVariantId: true,
        clauseVersionId: true,
        slotName: true,
      },
    }),
  );

  if (!existing) {
    return status(404, { message: "Link not found" });
  }

  await scopedDb(async (tx) => {
    await tx
      .delete(templateClauses)
      .where(
        and(
          eq(templateClauses.id, linkId),
          eq(templateClauses.templateId, templateId),
        ),
      );

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_TEMPLATE_LINK,
      resourceId: linkId,
      changes: {
        deleted: {
          old: {
            templateId,
            clauseId: existing.clauseId,
            clauseVariantId: existing.clauseVariantId,
            clauseVersionId: existing.clauseVersionId,
            slotName: existing.slotName,
          },
          new: null,
        },
      },
    });
  });

  return {};
};

// ── Sync to latest version ──────────────────────────

type SyncClauseProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  linkId: SafeId<"templateClause">;
  recordAuditEvent: AuditRecorder;
};

export const syncClauseHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  linkId,
  recordAuditEvent,
}: SyncClauseProps) => {
  const template = await verifyTemplateOwnership(
    scopedDb,
    templateId,
    organizationId,
  );

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const link = await scopedDb((tx) =>
    tx.query.templateClauses.findFirst({
      where: {
        id: { eq: linkId },
        templateId: { eq: templateId },
        organizationId: { eq: organizationId },
      },
      columns: {
        id: true,
        clauseId: true,
        clauseVersionId: true,
      },
    }),
  );

  if (!link) {
    return status(404, { message: "Link not found" });
  }

  const clauseId = link.clauseId;
  if (!clauseId) {
    return status(400, {
      message: "Clause has been deleted",
    });
  }

  // Verify clause still belongs to organization
  const clause = await scopedDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: { eq: clauseId },
        organizationId: { eq: organizationId },
      },
      columns: { id: true, currentVersion: true },
    }),
  );

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const latestVersion = await scopedDb((tx) =>
    tx.query.clauseVersions.findFirst({
      where: {
        clauseId: { eq: clauseId },
        version: clause.currentVersion,
        organizationId: { eq: organizationId },
      },
      columns: { id: true, version: true },
    }),
  );

  if (!latestVersion) {
    return status(404, {
      message: "Version not found",
    });
  }

  const updated = await scopedDb(async (tx) => {
    const [row] = await tx
      .update(templateClauses)
      .set({ clauseVersionId: latestVersion.id })
      .where(
        and(
          eq(templateClauses.id, linkId),
          eq(templateClauses.templateId, templateId),
        ),
      )
      .returning({
        id: templateClauses.id,
        clauseVersionId: templateClauses.clauseVersionId,
      });

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_TEMPLATE_LINK,
      resourceId: linkId,
      changes: {
        clauseVersionId: {
          old: link.clauseVersionId,
          new: latestVersion.id,
        },
      },
      metadata: { syncedToVersion: latestVersion.version },
    });

    return row;
  });

  if (!updated) {
    panic("Failed to sync template clause link");
  }

  return updated;
};

// ── Sync all outdated links ─────────────────────────

type SyncAllClausesProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  recordAuditEvent: AuditRecorder;
};

/**
 * Re-pin every outdated link of a template to its clause's current
 * version. Runs in a single transaction (one `scopedDb` call) and
 * records the same audit event as the single-link sync, including
 * the synced version number, for each updated link.
 */
export const syncAllClausesHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  recordAuditEvent,
}: SyncAllClausesProps) => {
  const template = await verifyTemplateOwnership(
    scopedDb,
    templateId,
    organizationId,
  );

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const syncedLinkIds = await scopedDb(async (tx) => {
    const links = await tx.query.templateClauses.findMany({
      where: {
        templateId: { eq: templateId },
        organizationId: { eq: organizationId },
      },
      columns: { id: true, clauseId: true, clauseVersionId: true },
      with: {
        clause: { columns: { id: true, currentVersion: true } },
        clauseVersion: { columns: { version: true } },
      },
      limit: LIMITS.templateClausesPerTemplate,
    });

    const synced: SafeId<"templateClause">[] = [];

    for (const link of links) {
      if (!isOutdatedLink(link) || !link.clauseId || !link.clause) {
        continue;
      }

      const latestVersion = await tx.query.clauseVersions.findFirst({
        where: {
          clauseId: { eq: link.clauseId },
          version: link.clause.currentVersion,
          organizationId: { eq: organizationId },
        },
        columns: { id: true, version: true },
      });

      if (!latestVersion) {
        continue;
      }

      await tx
        .update(templateClauses)
        .set({ clauseVersionId: latestVersion.id })
        .where(
          and(
            eq(templateClauses.id, link.id),
            eq(templateClauses.templateId, templateId),
          ),
        );

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_TEMPLATE_LINK,
        resourceId: link.id,
        changes: {
          clauseVersionId: {
            old: link.clauseVersionId,
            new: latestVersion.id,
          },
        },
        metadata: { syncedToVersion: latestVersion.version, bulkSync: true },
      });

      synced.push(link.id);
    }

    return synced;
  });

  return { syncedCount: syncedLinkIds.length };
};
