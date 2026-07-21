import { Result } from "better-result";
import { t } from "elysia";

import { resolveScopedGate } from "@/api/handlers/playbooks/materialize-run";
import {
  resolveEffectiveAsk,
  selectEnabledPositions,
} from "@/api/handlers/playbooks/position-runtime";
import type { ResolvedTiers } from "@/api/handlers/playbooks/positions";
import {
  loadClauseSnapshots,
  resolveTiers,
} from "@/api/handlers/playbooks/resolve-standards";
import { extractAskContents } from "@/api/handlers/playbooks/review-extract";
import type { ReviewAsk } from "@/api/handlers/playbooks/review-extract";
import { buildFindings } from "@/api/handlers/playbooks/review-grade";
import type { ReviewFinding } from "@/api/handlers/playbooks/review-grade";
import {
  assertUsageAvailableForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";
import { isAISupportedFile } from "@/api/lib/workflow/generate-batch";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";

// Synchronous, ephemeral single-document review: grade one document against an
// org playbook and return Findings inline. Unlike `run.ts` (the files-table
// run) this materializes NO columns, persists NO fields/justifications, and
// queues NO workflow — the only write is the audit row.
const config = {
  permissions: { playbook: ["apply"] },
  access: "read",
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: workspaceParams({ playbookId: tSafeId("playbookDefinition") }),
  // `entityId` and `fileFieldId` identify the active document inside the
  // already-validated workspace, not ownership ids; ownership comes from the
  // path (workspaceId) and session (organizationId).
  body: t.Object({
    entityId: tSafeId("entity"),
    fileFieldId: tSafeId("field"),
  }),
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
    user,
  }) {
    const organizationId = session.activeOrganizationId;

    yield* requireTanStackAIAvailableForRole({
      orgConfig: orgAIConfig,
      role: "pdf",
    });

    const loaded = yield* Result.await(
      safeDb(async (tx) => {
        const playbook = await tx.query.playbookDefinitions.findFirst({
          where: {
            id: { eq: params.playbookId },
            organizationId: { eq: organizationId },
          },
          columns: { positions: true, scope: true },
        });
        if (!playbook) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Playbook not found",
          };
        }

        // The ephemeral review must not widen a playbook's scope past what the
        // materialized run would gate: a document-type-scoped playbook grades a
        // document only when its classified type matches, so enforce that gate
        // here too instead of reviewing any document from the inspector.
        const gateResult = await resolveScopedGate({
          tx,
          workspaceId,
          organizationId,
          scope: playbook.scope,
        });
        if (!gateResult.ok) {
          return {
            ok: false as const,
            status: gateResult.status,
            message: gateResult.message,
          };
        }
        const docTypeGate = gateResult.gate;

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
              with: {
                fields: {
                  columns: { id: true, content: true, propertyId: true },
                },
              },
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
        const activeField = entity.currentVersion.fields.find(
          (field) => field.id === body.fileFieldId,
        );
        if (!activeField) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Document file not found",
          };
        }
        const activeContent = activeField.content;
        if (activeContent.type !== "file") {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Document file not found",
          };
        }
        const activeFile = {
          fieldId: activeField.id,
          content: activeContent,
        };

        // Gate matches the materialized run's semantics: an unclassified or
        // differently-classified document is skipped there, so reject it here.
        if (docTypeGate !== null) {
          const classifierField = entity.currentVersion.fields.find(
            (field) => field.propertyId === docTypeGate.propertyId,
          );
          const classifierContent = classifierField?.content;
          const classifiedType =
            classifierContent?.type === "single-select"
              ? classifierContent.value
              : null;
          if (classifiedType !== docTypeGate.label) {
            return {
              ok: false as const,
              status: 422 as const,
              message:
                "This playbook is scoped to a different document type than this document's classification.",
            };
          }
        }

        // Skip disabled positions, matching the materialized run's semantics.
        const positions = selectEnabledPositions(playbook.positions.items);
        const clauseSnapshots = await loadClauseSnapshots(
          tx,
          organizationId,
          positions,
        );

        return {
          ok: true as const,
          positions,
          entityVersionId: entity.currentVersion.id,
          activeFile,
          clauseSnapshots,
        };
      }),
    );

    if (!loaded.ok) {
      return Result.err(
        new HandlerError({ status: loaded.status, message: loaded.message }),
      );
    }

    const { positions, entityVersionId, activeFile, clauseSnapshots } = loaded;

    const tiersBySourceId = new Map<string, ResolvedTiers>();
    for (const position of positions) {
      if (position.mode === "graded") {
        tiersBySourceId.set(
          position.sourceId,
          resolveTiers(position, clauseSnapshots),
        );
      }
    }

    const resolvedFile: ResolvedFile = {
      fileFieldId: activeFile.fieldId,
      fileId: activeFile.content.id,
      mimeType: activeFile.content.mimeType,
      sha256Hex: activeFile.content.sha256Hex,
      encrypted: activeFile.content.encrypted,
      pdfFileId: activeFile.content.pdfFileId,
    };
    const resolvedFiles: ResolvedFile[] = [resolvedFile];

    const asks: ReviewAsk[] = [];
    const askSourceIds = new Set<string>();
    for (const position of positions) {
      const ask = resolveEffectiveAsk(position);
      const question = ask.question.trim();
      if (question.length === 0) {
        continue;
      }
      const content = ask.content;
      if (content.type === "file") {
        continue;
      }
      asks.push({ sourceId: position.sourceId, question, content });
      askSourceIds.add(position.sourceId);
    }

    // A document the extraction pipeline cannot read (not a PDF/DOCX and not a
    // convertible file with a PDF derivative) would yield no extracted content,
    // so every ASK would be graded as "missing". Reject it before grading rather
    // than returning findings that only reflect an unreadable file.
    if (asks.length > 0 && !isAISupportedFile(resolvedFile)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message:
            "This document format is not supported for automated review.",
        }),
      );
    }

    const abortSignal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
    const serviceTier = "standard" as const;
    const usageMetering = {
      actionType: "chat" as const,
      organizationId,
      safeDb,
      serviceTier,
      userId: user.id,
      workspaceId,
    };

    if (asks.length > 0) {
      const preflightError = await assertUsageAvailableForHandler({
        metering: { actionType: "chat", modelRole: "pdf" },
        organizationId,
        orgAIConfig,
        workspaceId,
        userId: user.id,
        safeDb,
      });
      if (preflightError) {
        return Result.err(preflightError);
      }
    }

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
      usageMetering,
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

    const gradedFindings: ReviewFinding[] = await buildFindings({
      positions: positions.filter((position) =>
        askSourceIds.has(position.sourceId),
      ),
      contentBySourceId: extractionResult.value.contentBySourceId,
      tiersBySourceId,
      lastBlockId: extractionResult.value.lastBlockId,
      abortSignal,
      organizationId,
      workspaceId,
      entityVersionId,
      orgAIConfig,
      promptCachingEnabled,
      serviceTier,
      usageMetering,
    });

    // Only actionable verdicts are surfaced as review findings. Compliant,
    // fallback (an accepted alternative), and extract-only (no verdict)
    // positions are not issues, so the inspector shows "No issues found" when a
    // document satisfies the playbook instead of rendering non-issue cards.
    const findings = gradedFindings.filter(
      (finding) =>
        finding.verdict === "deviation" || finding.verdict === "missing",
    );

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
