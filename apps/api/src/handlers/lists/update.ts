import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { LEGAL_LIST_STATUSES, legalLists } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";
import { includes } from "@/api/lib/type-guards";

const bodySchema = t.Object({
  id: tSafeId("legalList"),
  name: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  description: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  status: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
});

const config = {
  permissions: { view: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: bodySchema,
} satisfies HandlerConfig;

const parseLegalListStatus = (value: string | undefined) => {
  if (value === undefined || includes(LEGAL_LIST_STATUSES, value)) {
    return value;
  }
  return null;
};

const updateList = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const status = parseLegalListStatus(body.status);
    if (status === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid List status" }),
      );
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx.query.legalLists.findFirst({
          where: {
            id: { eq: body.id },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            id: true,
            name: true,
            description: true,
            status: true,
          },
        });
        if (!existing) {
          return null;
        }

        const updates = pickDefined(
          { name: body.name, description: body.description, status },
          ["name", "description", "status"],
        );
        const changes: Record<string, { old: unknown; new: unknown }> = {};
        for (const field of ["name", "description", "status"] as const) {
          const next = updates[field];
          if (next !== undefined && next !== existing[field]) {
            changes[field] = { old: existing[field], new: next };
          }
        }

        if (Object.keys(changes).length === 0) {
          return existing;
        }

        await tx
          .update(legalLists)
          .set({ ...updates, updatedAt: new Date() })
          .where(
            and(
              eq(legalLists.id, body.id),
              eq(legalLists.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST,
          resourceId: body.id,
          changes,
        });

        return { ...existing, ...updates };
      }),
    );

    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "List not found" }),
      );
    }

    return Result.ok({ id: result.id });
  },
);

export default updateList;
