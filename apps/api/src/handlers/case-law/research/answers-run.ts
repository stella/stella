import { Result } from "better-result";

import {
  readNamedResearchColumns,
  readOrganizationResearchColumns,
} from "@/api/handlers/case-law/research/column-access";
import { runResearchAnswersBodySchema } from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionSummaries } from "@/api/lib/case-law/decision-summaries";
import { queueResearchAnswerCells } from "@/api/lib/case-law/research-answer-queue";
import { runResearchAnswers } from "@/api/lib/case-law/research-answer-runner";
import type { ResearchRunColumn } from "@/api/lib/case-law/research-answer-runner";
import { detached } from "@/api/lib/detached";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createRootSafeDb } from "@/api/lib/root-scoped-db";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

const config = {
  description:
    "Queue answers for the given decisions in the given question columns " +
    "(every column the organization keeps, when none is named). Cells that " +
    "already hold an answer are kept unless `force` is set; cells another " +
    "run is still working on are skipped. Answering continues after the " +
    "response; poll the answers.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  body: runResearchAnswersBodySchema,
} satisfies HandlerConfig;

const runResearchAnswersHandler = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    orgAIConfigStatus,
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
        const requestedColumnIds = body.columnIds;
        // Locked until the pending cells are written, so a question edited in
        // between cannot have the old wording answered under the new heading.
        const columns =
          requestedColumnIds === undefined
            ? await readOrganizationResearchColumns({
                tx,
                organizationId: session.activeOrganizationId,
                lock: true,
              })
            : await readNamedResearchColumns({
                tx,
                columnIds: requestedColumnIds,
                organizationId: session.activeOrganizationId,
                lock: true,
              });
        if (columns === null) {
          return null;
        }
        const claim = await queueResearchAnswerCells({
          tx,
          organizationId: session.activeOrganizationId,
          columnIds: columns.map((column) => column.id),
          decisionIds,
          force: body.force === true,
          now: new Date(),
        });
        if (claim.cells.length > 0) {
          await recordAuditEvent(
            tx,
            columns.map((column) => ({
              action: AUDIT_ACTION.EXECUTE,
              resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_COLUMN,
              resourceId: column.id,
              metadata: { decisionCount: decisionIds.length },
            })),
          );
        }
        return { columns, claim };
      }),
    );
    if (queued === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Question column not found" }),
      );
    }
    if (queued.claim.cells.length === 0) {
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
          claim: queued.claim,
          orgAIConfig,
          promptCachingEnabled,
        },
        {
          // The run outlives the request; this scope carries the caller's
          // organization and user, so RLS applies exactly as it did here.
          safeDb: createRootSafeDb({
            organizationId: session.activeOrganizationId,
            userId: user.id,
            workspaceIds: [],
          }),
          caseLawDb: caseLawPublicReadDb,
        },
      ),
      "case-law-research.run-answers",
    );

    return Result.ok({ queued: queued.claim.cells.length });
  },
);

export default runResearchAnswersHandler;
