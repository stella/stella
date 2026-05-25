import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import { workspaceViews } from "@/api/db/schema";
import {
  hasDuplicateSorts,
  hasMultipleKindFilters,
} from "@/api/handlers/views/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { broadcast } from "@/api/lib/sse";
import {
  parseViewLayout,
  tCreateViewInputSchema,
} from "@/api/lib/views-schema";

const config = {
  permissions: { view: ["create"] },
  body: tCreateViewInputSchema,
} satisfies HandlerConfig;

const createView = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const layout = parseViewLayout(body.layout);

    if (hasDuplicateSorts(layout.sorts)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Duplicate sort property" }),
      );
    }

    if (hasMultipleKindFilters(layout.filters)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Multiple kind filters" }),
      );
    }

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx
          .select({ id: workspaceViews.id, layout: workspaceViews.layout })
          .from(workspaceViews)
          .where(eq(workspaceViews.workspaceId, workspaceId))
          .for("update");

        const hasOverviewView = existing.some(
          (view) => parseViewLayout(view.layout).type === "overview",
        );

        if (layout.type === "overview" && hasOverviewView) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Overview view already exists",
          };
        }

        if (existing.length >= LIMITS.viewsCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Views limit reached",
          };
        }

        const [maxRow] = await tx
          .select({
            max: sql<number>`coalesce(max(${workspaceViews.position}), -1)`,
          })
          .from(workspaceViews)
          .where(eq(workspaceViews.workspaceId, workspaceId));

        const nextPosition = (maxRow?.max ?? -1) + 1;

        const [inserted] = await tx
          .insert(workspaceViews)
          .values({
            id: body.id,
            workspaceId,
            name: body.name,
            layout,
            position: nextPosition,
          })
          .returning();

        if (!inserted) {
          return {
            ok: false as const,
            status: 500 as const,
            message: "Failed to create view",
          };
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW,
          resourceId: inserted.id,
          changes: {
            created: {
              old: null,
              new: {
                name: inserted.name,
                layoutType: layout.type,
                position: inserted.position,
              },
            },
          },
        });

        return {
          ok: true as const,
          view: {
            version: 1 as const,
            id: inserted.id,
            name: inserted.name,
            layout: inserted.layout,
            position: inserted.position,
            createdAt: inserted.createdAt.toISOString(),
          },
        };
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

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return Result.ok(txResult.view);
  },
);

export default createView;
