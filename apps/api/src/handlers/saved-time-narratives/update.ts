import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { savedTimeNarratives } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { narrativeLanguageSchema } from "@/api/lib/billing/narrative-language";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

import {
  savedTimeNarrativeParamsSchema,
  toSavedTimeNarrativeItem,
} from "./schema";

const config = {
  description:
    "Update a personal saved time narrative in the active organization.",
  permissions: { timeEntry: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: savedTimeNarrativeParamsSchema,
  body: t.Object({
    name: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
    narrative: t.Optional(t.String({ minLength: 1, maxLength: 10_000 })),
    narrativeLanguage: t.Optional(narrativeLanguageSchema),
  }),
} satisfies HandlerConfig;

const updateSavedTimeNarrative = createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session, user, recordAuditEvent }) {
    if (
      (body.name !== undefined && !body.name.trim()) ||
      (body.narrative !== undefined && !body.narrative.trim())
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Name and narrative must contain text",
        }),
      );
    }
    const updates = pickDefined(body, [
      "name",
      "narrative",
      "narrativeLanguage",
    ]);
    if (Object.keys(updates).length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "No changes provided" }),
      );
    }
    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .update(savedTimeNarratives)
          .set({ ...updates, updatedAt: new Date() })
          .where(
            and(
              eq(savedTimeNarratives.id, params.id),
              eq(
                savedTimeNarratives.organizationId,
                session.activeOrganizationId,
              ),
              eq(savedTimeNarratives.userId, user.id),
            ),
          )
          .returning();
        const row = rows.at(0);
        if (!row) {
          return null;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.SAVED_TIME_NARRATIVE,
          resourceId: row.id,
          changes: { fields: { old: null, new: Object.keys(updates) } },
        });
        return row;
      }),
    );
    if (!updated) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Saved time narrative not found",
        }),
      );
    }
    return Result.ok(toSavedTimeNarrativeItem(updated));
  },
);

export default updateSavedTimeNarrative;
