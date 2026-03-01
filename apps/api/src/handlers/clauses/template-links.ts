import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { templateClauses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

// ── Schemas ─────────────────────────────────────────

export const linkClauseBodySchema = t.Object({
  clauseId: tNanoid,
  variantId: t.Optional(tNanoid),
  slotName: t.Optional(t.String({ maxLength: 128 })),
});

type LinkClauseBody = Static<typeof linkClauseBodySchema>;

// ── Helpers ─────────────────────────────────────────

const verifyTemplateOwnership = async (
  templateId: string,
  organizationId: SafeId<"organization">,
) => {
  const template = await db.query.templates.findFirst({
    where: { id: templateId, organizationId },
    columns: { id: true },
  });

  return template;
};

// ── List linked clauses ─────────────────────────────

type ListTemplateClausesProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
};

export const listTemplateClausesHandler = async ({
  organizationId,
  templateId,
}: ListTemplateClausesProps) => {
  const template = await verifyTemplateOwnership(templateId, organizationId);

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const links = await db.query.templateClauses.findMany({
    where: { templateId },
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
  });

  return {
    links: links.map((link) => ({
      ...link,
      isOutdated:
        link.clause !== null &&
        link.clauseVersion !== null &&
        link.clauseVersion.version < link.clause.currentVersion,
    })),
  };
};

// ── Link clause to template ─────────────────────────

type LinkClauseProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
  body: LinkClauseBody;
};

export const linkClauseHandler = async ({
  organizationId,
  templateId,
  body,
}: LinkClauseProps) => {
  const template = await verifyTemplateOwnership(templateId, organizationId);

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const linkCount = await db.$count(
    templateClauses,
    eq(templateClauses.templateId, templateId),
  );

  if (linkCount >= LIMITS.templateClausesPerTemplate) {
    return status(400, {
      message: "Template clause limit reached",
    });
  }

  // Verify clause belongs to same organization
  const clause = await db.query.clauses.findFirst({
    where: { id: body.clauseId, organizationId },
    columns: { id: true, currentVersion: true },
  });

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  // Verify variant if specified
  if (body.variantId) {
    const variant = await db.query.clauseVariants.findFirst({
      where: {
        id: body.variantId,
        clauseId: body.clauseId,
      },
      columns: { id: true },
    });

    if (!variant) {
      return status(404, {
        message: "Variant not found",
      });
    }
  }

  // Find the current version snapshot
  const currentVersion = await db.query.clauseVersions.findFirst({
    where: {
      clauseId: body.clauseId,
      version: clause.currentVersion,
    },
    columns: { id: true },
  });

  const [inserted] = await db
    .insert(templateClauses)
    .values({
      id: nanoid(),
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

  return inserted;
};

// ── Unlink ──────────────────────────────────────────

type UnlinkClauseProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
  linkId: string;
};

export const unlinkClauseHandler = async ({
  organizationId,
  templateId,
  linkId,
}: UnlinkClauseProps) => {
  const template = await verifyTemplateOwnership(templateId, organizationId);

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const existing = await db.query.templateClauses.findFirst({
    where: { id: linkId, templateId },
    columns: { id: true },
  });

  if (!existing) {
    return status(404, { message: "Link not found" });
  }

  await db
    .delete(templateClauses)
    .where(
      and(
        eq(templateClauses.id, linkId),
        eq(templateClauses.templateId, templateId),
      ),
    );

  return;
};

// ── Sync to latest version ──────────────────────────

type SyncClauseProps = {
  organizationId: SafeId<"organization">;
  templateId: string;
  linkId: string;
};

export const syncClauseHandler = async ({
  organizationId,
  templateId,
  linkId,
}: SyncClauseProps) => {
  const template = await verifyTemplateOwnership(templateId, organizationId);

  if (!template) {
    return status(404, { message: "Template not found" });
  }

  const link = await db.query.templateClauses.findFirst({
    where: { id: linkId, templateId },
    columns: {
      id: true,
      clauseId: true,
    },
  });

  if (!link) {
    return status(404, { message: "Link not found" });
  }

  if (!link.clauseId) {
    return status(400, {
      message: "Clause has been deleted",
    });
  }

  // Verify clause still belongs to organization
  const clause = await db.query.clauses.findFirst({
    where: { id: link.clauseId, organizationId },
    columns: { id: true, currentVersion: true },
  });

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const latestVersion = await db.query.clauseVersions.findFirst({
    where: {
      clauseId: link.clauseId,
      version: clause.currentVersion,
    },
    columns: { id: true, version: true },
  });

  if (!latestVersion) {
    return status(404, {
      message: "Version not found",
    });
  }

  const [updated] = await db
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

  return updated;
};
