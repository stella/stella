import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { workspaceViewTemplates } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  permissions: { view: ["delete"] },
  params: t.Object({
    templateId: tSafeId("workspaceViewTemplate"),
  }),
} satisfies HandlerConfig;

const deleteViewTemplate = createSafeHandler(
  config,
  async function* ({ safeDb, session, user, params }) {
    yield* Result.await(
      safeDb((tx) =>
        tx
          .delete(workspaceViewTemplates)
          .where(
            and(
              eq(workspaceViewTemplates.id, params.templateId),
              eq(
                workspaceViewTemplates.organizationId,
                session.activeOrganizationId,
              ),
              eq(workspaceViewTemplates.userId, user.id),
            ),
          ),
      ),
    );

    return Result.ok(undefined);
  },
);

export default deleteViewTemplate;
