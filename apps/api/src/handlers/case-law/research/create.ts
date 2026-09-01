import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { caseLawResearchTables } from "@/api/db/schema";
import {
  createResearchTableBodySchema,
  toResearchTableResponse,
} from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { parseCaseLawResearchSavedQuery } from "@/api/lib/case-law/research-saved-query";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "Save the current case-law search as a research table: a named, " +
    "re-runnable query whose rows are the decisions it returns, adjusted by " +
    "pins and exclusions. Refused once the member owns the maximum number " +
    "of tables.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  body: createResearchTableBodySchema,
} satisfies HandlerConfig;

const createResearchTable = createSafeRootHandler(
  config,
  async function* ({ body, recordAuditEvent, safeDb, session, user }) {
    const name = body.name.trim();
    if (name.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "A name is required" }),
      );
    }
    const savedQuery = parseCaseLawResearchSavedQuery(body.savedQuery);
    if (Result.isError(savedQuery)) {
      return Result.err(savedQuery.error);
    }

    const created = yield* Result.await(
      safeDb(async (tx) => {
        // Serialize the count-and-insert pair so concurrent tabs cannot bypass
        // the per-owner cap.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext(${user.id}))`,
        );
        const owned = await tx.$count(
          caseLawResearchTables,
          and(
            eq(
              caseLawResearchTables.organizationId,
              session.activeOrganizationId,
            ),
            eq(caseLawResearchTables.ownerUserId, user.id),
          ),
        );
        if (owned >= LIMITS.caseLawResearchTablesPerUser) {
          return null;
        }

        const [row] = await tx
          .insert(caseLawResearchTables)
          .values({
            id: createSafeId<"caseLawResearchTable">(),
            organizationId: session.activeOrganizationId,
            ownerUserId: user.id,
            name,
            savedQuery: savedQuery.value,
          })
          .returning();
        const table = row ?? panic("Research table insert returned no row");

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
          resourceId: table.id,
          metadata: { savedQueryVersion: savedQuery.value.version },
        });
        return table;
      }),
    );
    if (created === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Research table limit reached",
        }),
      );
    }

    return Result.ok(toResearchTableResponse(created));
  },
);

export default createResearchTable;
