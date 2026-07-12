import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import {
  playbookDefinitions,
  playbookDefinitionVersions,
} from "@/api/db/schema";
import { playbookDefinitionParamsSchema } from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { playbook: ["approve"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: playbookDefinitionParamsSchema,
} satisfies HandlerConfig;

/**
 * Approve a playbook definition (v1, advisory only — nothing in the run/
 * review path hard-blocks on `status`). In one transaction: snapshot the
 * CURRENT name/description/scope/positions into an immutable
 * `playbook_definition_versions` row at `max(version) + 1`, then flip the
 * definition to `status: "approved"` with `approvedAt`/`approvedBy` set.
 * Re-approving an already-approved playbook is allowed and simply appends
 * another snapshot (the version number always advances).
 */
const approvePlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, params, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const playbookId = params.playbookId;

    const approved = yield* Result.await(
      safeDb(async (tx) => {
        // Lock the definition row so two concurrent approvals cannot compute
        // the same next version (which would collide on the
        // (playbookDefinitionId, version) unique index below).
        const [locked] = await tx
          .select({
            id: playbookDefinitions.id,
            name: playbookDefinitions.name,
            description: playbookDefinitions.description,
            scope: playbookDefinitions.scope,
            positions: playbookDefinitions.positions,
            status: playbookDefinitions.status,
          })
          .from(playbookDefinitions)
          .where(
            and(
              eq(playbookDefinitions.id, playbookId),
              eq(playbookDefinitions.organizationId, organizationId),
            ),
          )
          .for("update");

        if (!locked) {
          return { ok: false as const };
        }

        const [latestVersion] = await tx
          .select({ version: playbookDefinitionVersions.version })
          .from(playbookDefinitionVersions)
          .where(
            eq(playbookDefinitionVersions.playbookDefinitionId, playbookId),
          )
          .orderBy(desc(playbookDefinitionVersions.version))
          .limit(1);

        const nextVersion = (latestVersion?.version ?? 0) + 1;
        const approvedAt = new Date();

        // oxlint-disable-next-line react-doctor/async-parallel -- sequential by design: same tx client (single Postgres connection can't run concurrent statements)
        await tx.insert(playbookDefinitionVersions).values({
          id: createSafeId<"playbookDefinitionVersion">(),
          organizationId,
          playbookDefinitionId: playbookId,
          version: nextVersion,
          name: locked.name,
          description: locked.description,
          scope: locked.scope,
          positions: locked.positions,
          createdBy: user.id,
        });

        await tx
          .update(playbookDefinitions)
          .set({
            status: "approved",
            approvedAt,
            approvedBy: user.id,
            updatedAt: approvedAt,
          })
          .where(
            and(
              eq(playbookDefinitions.id, playbookId),
              eq(playbookDefinitions.organizationId, organizationId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: playbookId,
          changes: {
            status: { old: locked.status, new: "approved" },
            version: { old: null, new: nextVersion },
          },
        });

        return { ok: true as const, version: nextVersion, approvedAt };
      }),
    );

    if (!approved.ok) {
      return Result.err(
        new HandlerError({ status: 404, message: "Playbook not found" }),
      );
    }

    return Result.ok({
      status: "approved" as const,
      approvedAt: approved.approvedAt.toISOString(),
      version: approved.version,
    });
  },
);

export default approvePlaybookDefinition;
