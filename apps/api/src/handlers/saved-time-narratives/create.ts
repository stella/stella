import { panic, Result } from "better-result";
import { t } from "elysia";

import { savedTimeNarratives } from "@/api/db/schema";
import { narrativeLanguageSchema } from "@/api/handlers/time-entries/narrative-language";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { toSavedTimeNarrativeItem } from "./schema";

const config = {
  description:
    "Save a personal named time narrative for reuse across matters in the active organization.",
  permissions: { timeEntry: ["create"] },
  mcp: { type: "capability", reason: "billing_admin" },
  body: t.Object({
    name: t.String({ minLength: 1, maxLength: 128 }),
    narrative: t.String({ minLength: 1, maxLength: 10_000 }),
    narrativeLanguage: t.Optional(narrativeLanguageSchema),
  }),
} satisfies HandlerConfig;

const createSavedTimeNarrative = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    if (!body.name.trim() || !body.narrative.trim()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Name and narrative must contain text",
        }),
      );
    }
    const created = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .insert(savedTimeNarratives)
          .values({
            organizationId: session.activeOrganizationId,
            userId: user.id,
            name: body.name,
            narrative: body.narrative,
            narrativeLanguage: body.narrativeLanguage ?? null,
          })
          .returning();
        const row = rows.at(0);
        if (!row) {
          return panic("Saved time narrative insert returned no row");
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.SAVED_TIME_NARRATIVE,
          resourceId: row.id,
          changes: { created: { old: null, new: { id: row.id } } },
        });
        return row;
      }),
    );
    return Result.ok(toSavedTimeNarrativeItem(created));
  },
);

export default createSavedTimeNarrative;
