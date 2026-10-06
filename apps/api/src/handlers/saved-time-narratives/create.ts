import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { savedTimeNarratives } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { narrativeLanguageSchema } from "@/api/lib/billing/narrative-language";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import { toSavedTimeNarrativeItem } from "./schema";

const config = {
  description:
    "Save a personal named time narrative for reuse across matters in the active organization.",
  permissions: { timeEntry: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
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
        // Serialize the count and insert for this user's narratives.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext(${`saved-time-narratives:${user.id}`}))`,
        );
        const count = await tx.$count(
          savedTimeNarratives,
          and(
            eq(
              savedTimeNarratives.organizationId,
              session.activeOrganizationId,
            ),
            eq(savedTimeNarratives.userId, user.id),
          ),
        );
        if (count >= LIMITS.savedTimeNarrativesPerUser) {
          return null;
        }
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
    if (!created) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Saved time narrative limit reached",
        }),
      );
    }
    return Result.ok(toSavedTimeNarrativeItem(created));
  },
);

export default createSavedTimeNarrative;
