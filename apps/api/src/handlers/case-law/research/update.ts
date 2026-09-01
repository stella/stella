import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { CaseLawResearchSavedQuery } from "@stll/api-contract";

import { caseLawResearchTables } from "@/api/db/schema";
import {
  researchTableParamsSchema,
  toResearchTableResponse,
  updateResearchTableBodySchema,
} from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { parseCaseLawResearchSavedQuery } from "@/api/lib/case-law/research-saved-query";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Rename a research table or replace the saved query its rows come from.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableParamsSchema,
  body: updateResearchTableBodySchema,
} satisfies HandlerConfig;

const updateResearchTable = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { tableId },
    recordAuditEvent,
    safeDb,
    session,
  }) {
    const name = body.name?.trim();
    if (name !== undefined && name.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "A name is required" }),
      );
    }
    let savedQuery: CaseLawResearchSavedQuery | undefined;
    if (body.savedQuery !== undefined) {
      const parsed = parseCaseLawResearchSavedQuery(body.savedQuery);
      if (Result.isError(parsed)) {
        return Result.err(parsed.error);
      }
      savedQuery = parsed.value;
    }
    if (name === undefined && savedQuery === undefined) {
      return Result.err(
        new HandlerError({ status: 400, message: "Nothing to update" }),
      );
    }

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const [row] = await tx
          .update(caseLawResearchTables)
          .set({
            ...(name === undefined ? {} : { name }),
            ...(savedQuery === undefined ? {} : { savedQuery }),
          })
          .where(
            and(
              eq(caseLawResearchTables.id, tableId),
              eq(
                caseLawResearchTables.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .returning();
        if (row === undefined) {
          return null;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
          resourceId: row.id,
          metadata: {
            renamed: name !== undefined,
            queryChanged: savedQuery !== undefined,
          },
        });
        return row;
      }),
    );
    if (updated === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Research table not found" }),
      );
    }

    return Result.ok(toResearchTableResponse(updated));
  },
);

export default updateResearchTable;
