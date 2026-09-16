import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { entityViews } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { entityViewParams, entityViewUpdateBody, response, validateEntityViewLayout, viewOwner } from "./shared";

const config = {
  description: "Change the name or layout of one personal cross-matter view. Other users' views cannot be changed.",
  permissions: { view: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  params: entityViewParams,
  body: entityViewUpdateBody,
} satisfies HandlerConfig;

export default createSafeRootHandler(config, async function* ({ body, params, safeDb, session, user, recordAuditEvent }) {
  const layout = body.layout === undefined ? Result.ok(undefined) : validateEntityViewLayout(body.layout);
  if (layout.isErr()) return Result.err(layout.error);
  const row = yield* Result.await(safeDb(async (tx) => {
    const where = and(eq(entityViews.id, params.viewId), viewOwner({ organizationId: session.activeOrganizationId, userId: user.id }));
    const before = (await tx.select().from(entityViews).where(where).limit(1).for("update")).at(0);
    if (!before) return null;
    const updated = (await tx.update(entityViews).set({
      ...(body.name === undefined ? {} : { name: body.name.trim() }),
      ...(layout.value === undefined ? {} : { layout: layout.value }),
      updatedAt: new Date(),
    }).where(where).returning()).at(0);
    if (!updated) return panic("Locked view update returned no row");
    await recordAuditEvent(tx, { action: AUDIT_ACTION.UPDATE, resourceType: AUDIT_RESOURCE_TYPE.VIEW, resourceId: updated.id, changes: { name: { old: before.name, new: updated.name }, layout: { old: before.layout, new: updated.layout } } });
    return updated;
  }));
  if (!row) return Result.err(new HandlerError({ status: 404, message: "View not found" }));
  return Result.ok(response(row));
});
