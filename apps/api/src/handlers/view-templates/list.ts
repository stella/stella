import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import { workspaceViewTemplates } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";
import { parseViewLayout } from "@/api/lib/views-schema";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const toResponse = (template: typeof workspaceViewTemplates.$inferSelect) => {
  const layout = parseViewLayout(template.layout);
  return {
    version: 1 as const,
    id: template.id,
    name: template.name,
    layout,
    templateProperties: template.templateProperties,
    layoutType: layout.type,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
};

const listViewTemplates = createSafeHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(workspaceViewTemplates)
          .where(
            and(
              eq(
                workspaceViewTemplates.organizationId,
                session.activeOrganizationId,
              ),
              eq(workspaceViewTemplates.userId, user.id),
            ),
          )
          .orderBy(desc(workspaceViewTemplates.createdAt))
          .limit(LIMITS.viewTemplatesPerUser),
      ),
    );

    return Result.ok(rows.map(toResponse));
  },
);

export default listViewTemplates;
