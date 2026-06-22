import { Result } from "better-result";
import { and, desc, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { member, user } from "@/api/db/auth-schema";
import { templates } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const UNCATEGORIZED = "uncategorized" as const;

const listTemplatesQuerySchema = t.Object({
  categoryId: t.Optional(
    t.Union([tSafeId("templateCategory"), t.Literal(UNCATEGORIZED)]),
  ),
});

type ListTemplatesProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  query: { categoryId?: SafeId<"templateCategory"> | typeof UNCATEGORIZED };
};

const listTemplatesHandler = async function* ({
  safeDb,
  organizationId,
  query,
}: ListTemplatesProps) {
  const conditions = [eq(templates.organizationId, organizationId)];

  if (query.categoryId === UNCATEGORIZED) {
    conditions.push(isNull(templates.categoryId));
  } else if (query.categoryId) {
    conditions.push(eq(templates.categoryId, query.categoryId));
  }

  const result = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: templates.id,
          name: templates.name,
          fileName: templates.fileName,
          fieldCount: templates.fieldCount,
          sizeBytes: templates.sizeBytes,
          categoryId: templates.categoryId,
          createdAt: templates.createdAt,
          updatedAt: templates.updatedAt,
          lastUsedAt: templates.lastUsedAt,
          useCount: templates.useCount,
          tags: templates.tags,
          languages: templates.languages,
          whenToUse: templates.whenToUse,
          whenNotToUse: templates.whenNotToUse,
          authorName: user.name,
          authorImage: user.image,
        })
        .from(templates)
        // Author identity only for users still in the org: scope the
        // user join through membership so departed users render as
        // anonymous instead of leaking profile data.
        .leftJoin(
          member,
          and(
            eq(member.userId, templates.createdBy),
            eq(member.organizationId, organizationId),
          ),
        )
        .leftJoin(user, eq(user.id, member.userId))
        .where(and(...conditions))
        .orderBy(desc(templates.createdAt))
        .limit(LIMITS.templatesCount),
    ),
  );

  return Result.ok({
    templates: result,
    templatesCountLimit: LIMITS.templatesCount,
  });
};

const config = {
  permissions: { workspace: ["read"] },
  query: listTemplatesQuerySchema,
} satisfies HandlerConfig;

const listTemplates = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    return yield* listTemplatesHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      query,
    });
  },
);

export default listTemplates;
