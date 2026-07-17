import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { legalListSections } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  name: t.String({ minLength: 1, maxLength: 256 }),
  position: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
});

const config = {
  permissions: { view: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: bodySchema,
} satisfies HandlerConfig;

const createSection = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const list = await tx.query.legalLists.findFirst({
          where: {
            id: { eq: body.listId },
            workspaceId: { eq: workspaceId },
            status: { eq: "active" },
          },
          columns: { id: true },
        });
        if (!list) {
          return { status: "missing" as const };
        }

        const count = await tx.$count(
          legalListSections,
          and(
            eq(legalListSections.workspaceId, workspaceId),
            eq(legalListSections.listId, body.listId),
          ),
        );
        if (count >= LIMITS.legalListSectionsPerList) {
          return { status: "limit" as const };
        }

        const id = createSafeId<"legalListSection">();
        await tx.insert(legalListSections).values({
          id,
          workspaceId,
          listId: body.listId,
          name: body.name,
          position: body.position ?? id,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST,
          resourceId: body.listId,
          metadata: { operation: "section_created", sectionId: id },
          changes: {
            section: { old: null, new: { id, name: body.name } },
          },
        });
        return { status: "created" as const, id };
      }),
    );

    if (result.status === "missing") {
      return Result.err(
        new HandlerError({ status: 404, message: "Active List not found" }),
      );
    }
    if (result.status === "limit") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "List section limit reached",
        }),
      );
    }
    return Result.ok({ id: result.id });
  },
);

export default createSection;
