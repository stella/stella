import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { templateClauses } from "@/api/db/schema";
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
      clauseVersionId: link.clauseVersionId,
      slotName: link.slotName,
      sortOrder: link.sortOrder,
      insertedAt: link.insertedAt,
      clause: link.clause,
      clauseVersion: link.clauseVersion,
      clauseVariant: link.clauseVariant,
      isOutdated:
        link.clause !== null &&
        link.clauseVersion !== null &&
        link.clauseVersion.version < link.clause.currentVersion,
    })),
  };
};

// ── Link clause to template ─────────────────────────

type LinkClauseProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  body: LinkClauseBody;
};

export const linkClauseHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  body,
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

  // Verify variant if specified
  if (body.variantId) {
    const variant = await scopedDb((tx) =>
      tx.query.clauseVariants.findFirst({
        where: {
          id: { eq: body.variantId },
          clauseId: { eq: body.clauseId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true },
      }),
    );

    if (!variant) {
      return status(404, {
        message: "Variant not found",
      });
    }
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
};

export const unlinkClauseHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  linkId,
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
      columns: { id: true },
    }),
  );

  if (!existing) {
    return status(404, { message: "Link not found" });
  }

  await scopedDb((tx) =>
    tx
      .delete(templateClauses)
      .where(
        and(
          eq(templateClauses.id, linkId),
          eq(templateClauses.templateId, templateId),
        ),
      ),
  );

  return undefined;
};

// ── Sync to latest version ──────────────────────────

type SyncClauseProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  linkId: SafeId<"templateClause">;
};

export const syncClauseHandler = async ({
  scopedDb,
  organizationId,
  templateId,
  linkId,
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

  const [updated] = await scopedDb((tx) =>
    tx
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
      }),
  );

  return updated;
};
