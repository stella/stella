import { Result } from "better-result";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";

import {
  caseLawResearchAnswers,
  caseLawResearchColumns,
} from "@/api/db/schema";
import {
  researchAnswersListQuerySchema,
  researchTableParamsSchema,
  toResearchAnswerResponse,
} from "@/api/handlers/case-law/research/schema";
import { findResearchTable } from "@/api/handlers/case-law/research/table-access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { isUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

const config = {
  description:
    "Every cell of a research table that has been queued or answered, keyed " +
    "by column and decision. The client polls this while cells are pending.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableParamsSchema,
  query: researchAnswersListQuerySchema,
} satisfies HandlerConfig;

type AnswersCursor = { columnId: string; decisionId: string };

const decodeAnswersCursor = (cursor: string): AnswersCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts === null || parts.length !== 2) {
    return null;
  }
  const [columnId, decisionId] = parts;
  return typeof columnId === "string" &&
    typeof decisionId === "string" &&
    isUuid(columnId) &&
    isUuid(decisionId)
    ? { columnId, decisionId }
    : null;
};

const listResearchAnswers = createSafeRootHandler(
  config,
  async function* ({ params: { tableId }, query, safeDb, session }) {
    const limit = query.limit ?? LIMITS.caseLawResearchAnswersPageSizeMax;
    const cursor =
      query.cursor === undefined ? null : decodeAnswersCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const page = yield* Result.await(
      safeDb(async (tx) => {
        const table = await findResearchTable({
          tx,
          tableId,
          organizationId: session.activeOrganizationId,
        });
        if (table === null) {
          return null;
        }
        const conditions = [
          eq(caseLawResearchColumns.tableId, tableId),
          eq(
            caseLawResearchAnswers.organizationId,
            session.activeOrganizationId,
          ),
        ];
        if (cursor !== null) {
          conditions.push(
            or(
              gt(caseLawResearchAnswers.columnId, cursor.columnId),
              and(
                eq(caseLawResearchAnswers.columnId, cursor.columnId),
                gt(caseLawResearchAnswers.decisionId, cursor.decisionId),
              ),
            ) ?? sql`false`,
          );
        }
        const rows = await tx
          .select({ answer: caseLawResearchAnswers })
          .from(caseLawResearchAnswers)
          .innerJoin(
            caseLawResearchColumns,
            eq(caseLawResearchColumns.id, caseLawResearchAnswers.columnId),
          )
          .where(and(...conditions))
          .orderBy(
            asc(caseLawResearchAnswers.columnId),
            asc(caseLawResearchAnswers.decisionId),
          )
          .limit(limit + 1);
        return createCursorPage({
          rows: rows.map((row) => toResearchAnswerResponse(row.answer)),
          limit,
          cursorForItem: (item) =>
            encodePaginationCursor([item.columnId, item.decisionId]),
        });
      }),
    );
    if (page === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Research table not found" }),
      );
    }

    return Result.ok(page);
  },
);

export default listResearchAnswers;
