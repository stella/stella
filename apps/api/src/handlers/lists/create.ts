import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { legalLists } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const bodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  description: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});

const config = {
  permissions: { view: ["create"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: bodySchema,
} satisfies HandlerConfig;

const createList = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const count = await tx.$count(
          legalLists,
          eq(legalLists.workspaceId, workspaceId),
        );
        if (count >= LIMITS.legalListsPerWorkspace) {
          return { status: "limit" as const };
        }

        const id = createSafeId<"legalList">();
        const created = await tx
          .insert(legalLists)
          .values({
            id,
            workspaceId,
            name: body.name,
            description: body.description ?? null,
            createdBy: user.id,
          })
          .returning({ id: legalLists.id });

        if (!created.at(0)) {
          panic("Failed to create legal List");
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST,
          resourceId: id,
          changes: {
            created: {
              old: null,
              new: {
                name: body.name,
                description: body.description ?? null,
                status: "active",
              },
            },
          },
        });

        return { status: "created" as const, id };
      }),
    );

    if (result.status === "limit") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Lists limit reached for this workspace",
        }),
      );
    }

    return Result.ok({ id: result.id });
  },
);

export default createList;
