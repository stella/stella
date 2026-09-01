import { Result } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";

// SAFETY: rootDb is used only to build the tenant-scoped handle the detached
// run writes through after the request scope has ended; the scope carries the
// caller's organization and user, so RLS applies exactly as in the request.
// eslint-disable-next-line no-restricted-imports -- background task outlives the request scope; no ctx.safeDb available
import { rootDb } from "@/api/db/root";
import {
  caseLawResearchAnswers,
  caseLawResearchColumns,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import {
  researchTableParamsSchema,
  runResearchAnswersBodySchema,
} from "@/api/handlers/case-law/research/schema";
import {
  findResearchTable,
  touchResearchTable,
} from "@/api/handlers/case-law/research/table-access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionSummaries } from "@/api/lib/case-law/decision-summaries";
import { runResearchAnswers } from "@/api/lib/case-law/research-answer-runner";
import type { ResearchRunColumn } from "@/api/lib/case-law/research-answer-runner";
import { detached } from "@/api/lib/detached";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

const config = {
  description:
    "Queue answers for the given decisions in the given columns (every " +
    "column when none is named). Cells that already hold an answer are kept " +
    "unless `force` is set; cells another run is still working on are " +
    "skipped. Answering continues after the response; poll the answers.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableParamsSchema,
  body: runResearchAnswersBodySchema,
} satisfies HandlerConfig;

const runResearchAnswersHandler = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    orgAIConfigStatus,
    params: { tableId },
    promptCachingEnabled,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    // AI availability is a property of the deployment; decided before any
    // cell is marked pending, so a missing key never leaves cells stuck.
    const available = requireTanStackAIAvailableForRole({
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      role: "fast",
    });
    if (Result.isError(available)) {
      return Result.err(available.error);
    }

    const requestedDecisionIds = [...new Set(body.decisionIds)];
    // The corpus is read through the same gate the public routes use: a
    // decision that may not be redistributed cannot be queued by id.
    const readable = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readPublicDecisionSummaries({
            caseLawDb: caseLawPublicReadDb,
            decisionIds: requestedDecisionIds,
          }),
      ),
    );
    const decisionIds = readable.map((decision) => decision.id);
    if (decisionIds.length === 0) {
      return Result.err(
        new HandlerError({ status: 404, message: "Decisions not found" }),
      );
    }

    const queued = yield* Result.await(
      safeDb(async (tx) => {
        const table = await findResearchTable({
          tx,
          tableId,
          organizationId: session.activeOrganizationId,
        });
        if (table === null) {
          return null;
        }
        const columnConditions = [
          eq(caseLawResearchColumns.tableId, tableId),
          eq(
            caseLawResearchColumns.organizationId,
            session.activeOrganizationId,
          ),
        ];
        if (body.columnIds !== undefined) {
          columnConditions.push(
            inArray(caseLawResearchColumns.id, body.columnIds),
          );
        }
        const columns = await tx
          .select({
            id: caseLawResearchColumns.id,
            question: caseLawResearchColumns.question,
            answerType: caseLawResearchColumns.answerType,
          })
          .from(caseLawResearchColumns)
          .where(and(...columnConditions))
          .orderBy(asc(caseLawResearchColumns.position))
          .limit(LIMITS.caseLawResearchColumnsPerTable);
        if (columns.length === 0) {
          return { columns: [], pairs: 0 };
        }

        const columnIds = columns.map((column) => column.id);
        const existing = await tx
          .select({
            columnId: caseLawResearchAnswers.columnId,
            decisionId: caseLawResearchAnswers.decisionId,
            state: caseLawResearchAnswers.state,
            updatedAt: caseLawResearchAnswers.updatedAt,
          })
          .from(caseLawResearchAnswers)
          .where(
            and(
              inArray(caseLawResearchAnswers.columnId, columnIds),
              inArray(caseLawResearchAnswers.decisionId, decisionIds),
              eq(
                caseLawResearchAnswers.organizationId,
                session.activeOrganizationId,
              ),
            ),
          );
        const existingByKey = new Map(
          existing.map((row) => [`${row.columnId}:${row.decisionId}`, row]),
        );
        const staleBefore = Date.now() - LIMITS.caseLawResearchPendingStaleMs;
        const now = new Date();
        const toQueue: (typeof caseLawResearchAnswers.$inferInsert)[] = [];
        for (const column of columns) {
          for (const decisionId of decisionIds) {
            const current = existingByKey.get(`${column.id}:${decisionId}`);
            // A live pending cell belongs to another run; a stale one is a run
            // that died. An answered cell is kept unless the caller forces.
            const skip =
              current !== undefined &&
              (current.state === "pending"
                ? current.updatedAt.getTime() >= staleBefore
                : current.state === "answered" && body.force !== true);
            if (skip) {
              continue;
            }
            toQueue.push({
              columnId: column.id,
              organizationId: session.activeOrganizationId,
              decisionId,
              state: "pending",
              answer: null,
              confidence: null,
              run: null,
              failureReason: null,
              updatedAt: now,
            });
          }
        }
        if (toQueue.length > 0) {
          await tx
            .insert(caseLawResearchAnswers)
            .values(toQueue)
            .onConflictDoUpdate({
              target: [
                caseLawResearchAnswers.columnId,
                caseLawResearchAnswers.decisionId,
              ],
              set: {
                state: "pending",
                answer: null,
                confidence: null,
                run: null,
                failureReason: null,
                updatedAt: now,
              },
            });
          await touchResearchTable({
            tx,
            tableId,
            organizationId: session.activeOrganizationId,
          });
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
            resourceId: tableId,
            metadata: {
              answersQueued: toQueue.length,
              columnCount: columns.length,
              decisionCount: decisionIds.length,
            },
          });
        }
        return { columns, pairs: toQueue.length };
      }),
    );
    if (queued === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Research table not found" }),
      );
    }
    if (queued.pairs === 0) {
      return Result.ok({ queued: 0 });
    }

    const runColumns: ResearchRunColumn[] = queued.columns.map((column) => ({
      columnId: column.id,
      question: column.question,
      answerType: column.answerType,
    }));
    detached(
      runResearchAnswers(
        {
          organizationId: session.activeOrganizationId,
          userId: user.id,
          columns: runColumns,
          decisionIds,
          orgAIConfig,
          promptCachingEnabled,
        },
        {
          safeDb: createSafeDb(
            rootDb,
            [],
            session.activeOrganizationId,
            user.id,
          ),
          caseLawDb: caseLawPublicReadDb,
        },
      ),
      "case-law-research.run-answers",
    );

    return Result.ok({ queued: queued.pairs });
  },
);

export default runResearchAnswersHandler;
