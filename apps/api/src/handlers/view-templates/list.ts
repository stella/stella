import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import { workspaceViewTemplates } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  AVT_LAYOUT_DISCOVERY_FEATURE_ACCESS,
  avtViewAccessStatus,
  isAvtLayoutVisible,
} from "@/api/lib/auth/feature-access/view-eligibility";
import { LIMITS } from "@/api/lib/limits";
import { parseStoredViewLayout } from "@/api/lib/views-schema";

const config = {
  description:
    "List your own saved view templates, newest first, each with its name, " +
    "layout, layout type, and the columns that layout needs. Personal: " +
    "templates saved by other members are never returned.",
  featureAccess: AVT_LAYOUT_DISCOVERY_FEATURE_ACCESS,
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workspace_schema",
    consumesServices: false,
  },
  access: "read",
} satisfies WorkspaceHandlerConfig;

const toResponse = (template: typeof workspaceViewTemplates.$inferSelect) => {
  const layout = parseStoredViewLayout(template.layout);
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
  async function* ({ safeDb, session, user, featureAccessSnapshot }) {
    const avtAccessStatus = avtViewAccessStatus({
      snapshot: featureAccessSnapshot,
      organizationId: session.activeOrganizationId,
      userId: user.id,
    });
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

    return Result.ok(
      rows
        .filter((row) => isAvtLayoutVisible(row.layout, avtAccessStatus))
        .map(toResponse),
    );
  },
);

export default listViewTemplates;
