import { panic, Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import {
  playbookDefinitions,
  playbookDefinitionVersions,
} from "@/api/db/schema";
import {
  approvePlaybookDefinitionBodySchema,
  playbookDefinitionParamsSchema,
} from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { assertUnchangedSince } from "@/api/lib/optimistic-concurrency";
import { PLAYBOOK_VERSION_SOURCE } from "@/api/lib/workflow/playbook-positions";

const config = {
  description:
    "Approve a playbook definition: snapshot its current name, description, " +
    "scope, and positions as a new immutable version, then mark the " +
    "definition approved. Runs pin the latest approved version, so this is " +
    "what publishes edits to reviews. Pass expectedUpdatedAt as a " +
    "concurrency token; a definition that changed since you read it is a " +
    "conflict. Approving an already-approved playbook is allowed and simply " +
    "appends another version.",
  permissions: { playbook: ["approve"] },
  access: "write",
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: playbookDefinitionParamsSchema,
  body: approvePlaybookDefinitionBodySchema,
} satisfies HandlerConfig;

/**
 * Approve a playbook definition (v1, advisory only — nothing in the run/
 * review path hard-blocks on `status`). In one transaction: snapshot the
 * CURRENT name/description/scope/positions into an immutable
 * `playbook_definition_versions` row at `max(version) + 1`, then flip the
 * definition to `status: "approved"` with `approvedAt`/`approvedBy` set.
 * The editor's expected update timestamp is checked under the same row lock,
 * so approval can never snapshot a definition that changed after it loaded.
 * Re-approving an already-approved playbook is allowed and simply appends
 * another snapshot (the version number always advances).
 */
const approvePlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, params, body, recordAuditEvent }) {
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
            updatedAt: playbookDefinitions.updatedAt,
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
          return { type: "not-found" as const };
        }

        const conflict = assertUnchangedSince({
          storedUpdatedAt: locked.updatedAt,
          expectedUpdatedAt: body.expectedUpdatedAt,
          resource: "Playbook",
        });
        if (conflict) {
          return { type: "version-conflict" as const, error: conflict };
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

        await tx.insert(playbookDefinitionVersions).values({
          id: createSafeId<"playbookDefinitionVersion">(),
          organizationId,
          playbookDefinitionId: playbookId,
          version: nextVersion,
          // What a run's "latest approved version" filters on. Approval is the
          // only reason this handler writes a snapshot.
          source: PLAYBOOK_VERSION_SOURCE.APPROVAL,
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

        return {
          type: "approved" as const,
          version: nextVersion,
          approvedAt,
        };
      }),
    );

    switch (approved.type) {
      case "approved":
        return Result.ok({
          status: "approved" as const,
          approvedAt: approved.approvedAt.toISOString(),
          // The approval also bumps `updatedAt`, so hand the new value back
          // for the caller's next concurrency token instead of leaving it to
          // infer one from `approvedAt`.
          updatedAt: approved.approvedAt.toISOString(),
          version: approved.version,
        });
      case "not-found":
        return Result.err(
          new HandlerError({ status: 404, message: "Playbook not found" }),
        );
      case "version-conflict":
        return Result.err(approved.error);
      default: {
        approved satisfies never;
        return panic(`Unhandled approved: ${String(approved)}`);
      }
    }
  },
);

export default approvePlaybookDefinition;
