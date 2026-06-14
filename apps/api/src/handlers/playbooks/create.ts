import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { playbooks } from "@/api/db/schema";
import { playbookBodySchema } from "@/api/handlers/playbooks/schema";
import {
  hasDuplicateColumnNames,
  validateTypeProperty,
} from "@/api/handlers/playbooks/validate";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { playbook: ["create"] },
  body: playbookBodySchema,
} satisfies HandlerConfig;

const createPlaybook = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
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
        const existing = await tx
          .select({ id: playbooks.id })
          .from(playbooks)
          .where(eq(playbooks.workspaceId, workspaceId));

        if (existing.length >= LIMITS.playbooksCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Playbooks limit reached",
          };
        }

        const typeCheck = await validateTypeProperty({
          tx,
          workspaceId,
          typePropertyId: body.typePropertyId,
          typeValue: body.typeValue,
        });
        if (!typeCheck.ok) {
          return typeCheck;
        }

        const [inserted] = await tx
          .insert(playbooks)
          .values({
            workspaceId,
            name: body.name,
            typePropertyId: body.typePropertyId,
            typeValue: body.typeValue,
            bundle: body.bundle,
          })
          .returning({ id: playbooks.id });

        if (!inserted) {
          return {
            ok: false as const,
            status: 500 as const,
            message: "Failed to create playbook",
          };
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: inserted.id,
          changes: {
            created: {
              old: null,
              new: { name: body.name, columnCount: body.bundle.length },
            },
          },
        });

        return { ok: true as const, id: inserted.id };
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

    return Result.ok({ id: txResult.id });
  },
);

export default createPlaybook;
