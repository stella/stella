import { and, desc, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { templates } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const UNCATEGORIZED = "uncategorized" as const;

export const listTemplatesQuerySchema = t.Object({
  categoryId: t.Optional(t.Union([tNanoid, t.Literal(UNCATEGORIZED)])),
});

type ListTemplatesProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  query: { categoryId?: string };
};

export const listTemplatesHandler = async ({
  scopedDb,
  organizationId,
  query,
}: ListTemplatesProps) => {
  const conditions = [eq(templates.organizationId, organizationId)];

  if (query.categoryId === UNCATEGORIZED) {
    conditions.push(isNull(templates.categoryId));
  } else if (query.categoryId) {
    conditions.push(eq(templates.categoryId, query.categoryId));
  }

  const result = await scopedDb((tx) =>
    tx
      .select({
        id: templates.id,
        name: templates.name,
        fileName: templates.fileName,
        fieldCount: templates.fieldCount,
        sizeBytes: templates.sizeBytes,
        categoryId: templates.categoryId,
        createdAt: templates.createdAt,
      })
      .from(templates)
      .where(and(...conditions))
      .orderBy(desc(templates.createdAt))
      .limit(LIMITS.templatesCount),
  );

  return {
    templates: result,
    templatesCountLimit: LIMITS.templatesCount,
  };
};
