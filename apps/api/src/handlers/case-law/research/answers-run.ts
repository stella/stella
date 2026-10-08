import { Result } from "better-result";

import {
  readNamedResearchColumns,
  readOrganizationResearchColumns,
} from "@/api/handlers/case-law/research/column-access";
import { runResearchAnswersBodySchema } from "@/api/handlers/case-law/research/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionSummaries } from "@/api/lib/case-law/decision-summaries";
import { queueResearchAnswerCells } from "@/api/lib/case-law/research-answer-queue";
import { runResearchAnswers } from "@/api/lib/case-law/research-answer-runner";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createDetachedModelActionStarter,
  modelActionRefusal,
} from "@/api/lib/rate-limit/model-action-admission";
import { createRootSafeDb } from "@/api/lib/root-scoped-db";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

const config = {
  access: "write",
  description:
    "Queue answers for the given decisions in the given question columns " +
    "(every column the organization keeps, when none is named). Cells that " +
    "already hold an answer are kept unless `force` is set; cells another " +
    "run is still working on are skipped. Answering continues after the " +
    "response; poll the answers.",
  permissions: { caseLawResearch: ["run"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "search_ui" },
  body: runResearchAnswersBodySchema,
  // The detached runner meters every model call under `case_law` at the
  // standard tier for the `fast` role (`research-answer-runner.ts`). Pricing
  // the pre-flight the same way refuses a run the organization cannot pay
  // for before any cell is claimed, instead of after the cells are pending.
  requiresUsage: {
    actionType: "case_law",
    serviceTier: "standard",
    modelRole: "fast",
  },
} satisfies HandlerConfig;

const runResearchAnswersHandler = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    managedAIResidency,
    orgAIConfigStatus,
    promptCachingEnabled,
    recordAuditEvent,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    // AI availability is a property of the deployment; decided before any
    // cell is marked pending, so a missing key never leaves cells stuck. The
    // usage pre-flight answers a different question (may this organization
    // spend) and rejects only an unreadable stored config, so the role's
    // provider and model support is still decided here.
    const available = requireTanStackAIAvailableForRole({
      dataClass: "customer",
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

    // The answers run after the response: the action is admitted before any
    // cell is claimed and held until the run settles.
    const started = await createDetachedModelActionStarter({
      organizationId: session.activeOrganizationId,
      userId: user.id,
      organizationStateDb: scopedDb,
      actionKind: "case-law.research-answers",
    })({
      label: "case-law-research.run-answers",
      start: async () =>
        await safeDb(async (tx) => {
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
      background: async ({ admission }, queued) => {
        if (
          Result.isError(queued) ||
          queued.value === null ||
          queued.value.claim.cells.length === 0
        ) {
          return;
        }
        await runResearchAnswers(
          {
            admission,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            columns: queued.value.columns.map((column) => ({
              columnId: column.id,
              question: column.question,
              content: column.content,
            })),
            claim: queued.value.claim,
            orgAIConfig,
            managedAIResidency,
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
        );
      },
    });
    if (Result.isError(started)) {
      return Result.err(modelActionRefusal(started.error));
    }
    const queued = yield* started.value;
    if (queued === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Question column not found" }),
      );
    }
    return Result.ok({ queued: queued.claim.cells.length });
  },
);

export default runResearchAnswersHandler;
