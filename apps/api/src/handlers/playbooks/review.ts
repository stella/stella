import { Result } from "better-result";
import { t } from "elysia";

import type { ResolvedStandard } from "@/api/handlers/playbooks/positions";
import {
  loadClauseSnapshots,
  resolveStandard,
} from "@/api/handlers/playbooks/resolve-standards";
import { extractAskContents } from "@/api/handlers/playbooks/review-extract";
import type { ReviewAsk } from "@/api/handlers/playbooks/review-extract";
import { buildFindings } from "@/api/handlers/playbooks/review-grade";
import type { ReviewFinding } from "@/api/handlers/playbooks/review-grade";
import { requireAIAvailable } from "@/api/lib/ai-models";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";

// Synchronous, ephemeral single-document review: grade one document against an
// org playbook and return Findings inline. Unlike `run.ts` (the files-table
// run) this materializes NO columns, persists NO fields/justifications, and
// queues NO workflow — the only write is the audit row.
const config = {
  permissions: { playbook: ["apply"] },
  params: workspaceParams({ playbookId: tSafeId("playbookDefinition") }),
  // `entityId` is the review target inside the already-validated workspace, not
  // an ownership id; ownership comes from the path (workspaceId) and session
  // (organizationId).
  body: t.Object({ entityId: tSafeId("entity") }),
} satisfies HandlerConfig;

// A single-doc review is a bounded operation (one document, one playbook's
// positions, capped at 200 by `playbookPositionsSchema`), so it runs inline
// rather than through the workflow queue.
const REVIEW_TIMEOUT_MS = 120_000;

const reviewPlaybook = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params,
    body,
    session,
    orgAIConfig,
    promptCachingEnabled,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;

    yield* requireAIAvailable(orgAIConfig);

    const loaded = yield* Result.await(
      safeDb(async (tx) => {
        const playbook = await tx.query.playbookDefinitions.findFirst({
          where: {
            id: { eq: params.playbookId },
            organizationId: { eq: organizationId },
          },
          columns: { positions: true },
        });
        if (!playbook) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Playbook not found",
          };
        }

        // Bounded single-doc read: one entity, its current version, and that
        // version's field rows (capped by the workspace property count; the
        // `fields` relation is unordered, so it is not a list read).
        const entity = await tx.query.entities.findFirst({
          where: {
            id: { eq: body.entityId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
          with: {
            currentVersion: {
              columns: { id: true },
              with: { fields: { columns: { id: true, content: true } } },
            },
          },
        });
        if (!entity?.currentVersion) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Document not found",
          };
        }

        const positions = playbook.positions.items;
        const clauseSnapshots = await loadClauseSnapshots(
          tx,
          organizationId,
          positions,
        );

        return {
          ok: true as const,
          positions,
          entityVersionId: entity.currentVersion.id,
          fieldEntries: entity.currentVersion.fields,
          clauseSnapshots,
        };
      }),
    );

    if (!loaded.ok) {
      return Result.err(
        new HandlerError({ status: loaded.status, message: loaded.message }),
      );
    }

    const { positions, entityVersionId, fieldEntries, clauseSnapshots } =
      loaded;

    const standardBySourceId = new Map<string, ResolvedStandard>();
    for (const position of positions) {
      standardBySourceId.set(
        position.sourceId,
        resolveStandard(position, clauseSnapshots),
      );
    }

    const resolvedFiles: ResolvedFile[] = [];
    for (const field of fieldEntries) {
      if (field.content.type !== "file") {
        continue;
      }
      resolvedFiles.push({
        fileFieldId: field.id,
        fileId: field.content.id,
        mimeType: field.content.mimeType,
        sha256Hex: field.content.sha256Hex,
        encrypted: field.content.encrypted,
        pdfFileId: field.content.pdfFileId,
      });
    }

    const asks: ReviewAsk[] = [];
    for (const position of positions) {
      const question = position.ask.question.trim();
      if (question.length === 0) {
        continue;
      }
      const content = position.ask.content;
      if (content.type === "file") {
        continue;
      }
      asks.push({ sourceId: position.sourceId, question, content });
    }

    const abortSignal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
    const serviceTier = "standard" as const;

    const extractionResult = await extractAskContents({
      asks,
      resolvedFiles,
      abortSignal,
      organizationId,
      workspaceId,
      entityVersionId,
      orgAIConfig,
      promptCachingEnabled,
      serviceTier,
    });
    if (Result.isError(extractionResult)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Internal server error",
          cause: extractionResult.error,
        }),
      );
    }

    const findings: ReviewFinding[] = await buildFindings({
      positions,
      contentBySourceId: extractionResult.value.contentBySourceId,
      standardBySourceId,
      lastBlockId: extractionResult.value.lastBlockId,
      abortSignal,
      organizationId,
      workspaceId,
      entityVersionId,
      orgAIConfig,
      promptCachingEnabled,
      serviceTier,
    });

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: params.playbookId,
          changes: {
            review: {
              old: null,
              new: { documentId: body.entityId, findingCount: findings.length },
            },
          },
        });
        return undefined;
      }),
    );

    return Result.ok(findings);
  },
);

export default reviewPlaybook;
