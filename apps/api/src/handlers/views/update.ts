import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import { workspaceViews } from "@/api/db/schema";
import {
  hasDuplicateSorts,
  hasMultipleKindFilters,
} from "@/api/handlers/views/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  tDefaultVarchar,
  tUuid,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";
import type { ViewLayout } from "@/api/lib/views-schema";
import { viewLayoutSchema } from "@/api/lib/views-schema";

const config = {
  permissions: { view: ["update"] },
  params: workspaceParams({ viewId: tUuid }),
  body: t.Object({
    name: t.Optional(tDefaultVarchar),
    layout: t.Optional(t.Any()),
  }),
} satisfies HandlerConfig;

const updateView = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params: { viewId }, body }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaceViews.findFirst({
          where: {
            id: viewId,
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "View not found" }),
      );
    }

    let parsedLayout: ViewLayout | undefined;
    if (body.layout !== undefined) {
      const parsed = v.safeParse(viewLayoutSchema, body.layout);
      if (!parsed.success) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid layout" }),
        );
      }
      parsedLayout = parsed.output;

      if (hasDuplicateSorts(parsedLayout.sorts)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Duplicate sort property",
          }),
        );
      }
      if (hasMultipleKindFilters(parsedLayout.filters)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Multiple kind filters",
          }),
        );
      }
      if (existing.layout.type !== parsedLayout.type) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Cannot change view type",
          }),
        );
      }
    }

    const updates: Partial<{ name: string; layout: ViewLayout }> = {};
    if (body.name !== undefined) {
      updates.name = body.name;
    }
    if (parsedLayout !== undefined) {
      updates.layout = parsedLayout;
    }

    if (Object.keys(updates).length === 0) {
      return Result.ok(undefined);
    }

    yield* Result.await(
      safeDb((tx) =>
        tx
          .update(workspaceViews)
          .set(updates)
          .where(
            and(
              eq(workspaceViews.id, viewId),
              eq(workspaceViews.workspaceId, workspaceId),
            ),
          ),
      ),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return Result.ok(undefined);
  },
);

export default updateView;
