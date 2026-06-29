import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { playbookDefinitions } from "@/api/db/schema";
import { assertPositionsValid } from "@/api/handlers/playbooks/positions-validation";
import {
  playbookDefinitionBodySchema,
  playbookDefinitionParamsSchema,
} from "@/api/handlers/playbooks/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { playbook: ["update"] },
  params: playbookDefinitionParamsSchema,
  body: playbookDefinitionBodySchema,
} satisfies HandlerConfig;

const updatePlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    yield* Result.await(
      assertPositionsValid({
        safeDb,
        organizationId,
        positions: body.positions,
      }),
    );

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const [row] = await tx
          .update(playbookDefinitions)
          .set({
            name: body.name,
            description: body.description ?? null,
            positions: body.positions,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(playbookDefinitions.id, params.playbookId),
              eq(playbookDefinitions.organizationId, organizationId),
            ),
          )
          .returning({ id: playbookDefinitions.id });

        if (!row) {
          return null;
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: params.playbookId,
          changes: {
            fields: { old: null, new: ["name", "description", "positions"] },
          },
        });

        return row;
      }),
    );

    if (!updated) {
      return Result.err(
        new HandlerError({ status: 404, message: "Playbook not found" }),
      );
    }

    return Result.ok({});
  },
);

export default updatePlaybookDefinition;
