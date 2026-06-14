import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { playbooks } from "@/api/db/schema";
import {
  playbookBodySchema,
  playbookParamsSchema,
} from "@/api/handlers/playbooks/schema";
import {
  hasDuplicateColumnNames,
  validateTypeProperty,
} from "@/api/handlers/playbooks/validate";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { playbook: ["update"] },
  params: playbookParamsSchema,
  body: playbookBodySchema,
} satisfies HandlerConfig;

const updatePlaybookById = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
    if (hasDuplicateColumnNames(body.bundle)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Playbook columns must have unique names",
        }),
      );
    }

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const typeCheck = await validateTypeProperty({
          tx,
          workspaceId,
          typePropertyId: body.typePropertyId,
          typeValue: body.typeValue,
        });
        if (!typeCheck.ok) {
          return typeCheck;
        }

        const updated = await tx
          .update(playbooks)
          .set({
            name: body.name,
            typePropertyId: body.typePropertyId,
            typeValue: body.typeValue,
            bundle: body.bundle,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(playbooks.id, params.playbookId),
              eq(playbooks.workspaceId, workspaceId),
            ),
          )
          .returning({ id: playbooks.id });

        if (updated.length === 0) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Playbook not found",
          };
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: params.playbookId,
          changes: {
            fields: {
              old: null,
              new: ["name", "typePropertyId", "typeValue", "bundle"],
            },
          },
        });

        return { ok: true as const };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    return Result.ok({});
  },
);

export default updatePlaybookById;
