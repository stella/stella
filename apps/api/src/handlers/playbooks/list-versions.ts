import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { playbookDefinitionVersions } from "@/api/db/schema";
import { playbookDefinitionParamsSchema } from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "knowledge_library_admin" },
  params: playbookDefinitionParamsSchema,
  query: t.Object({
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.playbookDefinitionVersionsPerPlaybook,
      }),
    ),
  }),
} satisfies HandlerConfig;

/**
 * List a playbook's approval-version history, newest first. Versions per
 * playbook are a small, bounded, per-parent collection (one row per
 * `approve` call — see `approve.ts`), so this returns a plain capped array
 * instead of a cursor page: there is no realistic history long enough to
 * need cursoring, and capping at `LIMITS.playbookDefinitionVersionsPerPlaybook`
 * bounds the worst case regardless.
 */
const listPlaybookVersions = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, query }) {
    const organizationId = session.activeOrganizationId;
    const playbookId = params.playbookId;

    const playbook = yield* Result.await(
      safeDb((tx) =>
        tx.query.playbookDefinitions.findFirst({
          where: {
            id: { eq: playbookId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!playbook) {
      return Result.err(
        new HandlerError({ status: 404, message: "Playbook not found" }),
      );
    }

    const limit = query.limit ?? LIMITS.playbookDefinitionVersionsPerPlaybook;

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            version: playbookDefinitionVersions.version,
            name: playbookDefinitionVersions.name,
            createdAt: playbookDefinitionVersions.createdAt,
            createdBy: playbookDefinitionVersions.createdBy,
          })
          .from(playbookDefinitionVersions)
          .where(
            and(
              eq(playbookDefinitionVersions.playbookDefinitionId, playbookId),
              eq(playbookDefinitionVersions.organizationId, organizationId),
            ),
          )
          .orderBy(desc(playbookDefinitionVersions.version))
          .limit(limit),
      ),
    );

    return Result.ok({
      items: rows.map((row) => ({
        version: row.version,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy,
      })),
    });
  },
);

export default listPlaybookVersions;
