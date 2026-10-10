import { Result } from "better-result";
import { t } from "elysia";

import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { summarizeVersionChange } from "@/api/lib/entity-versions/version-change-summary";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { loadClauseVersionDiffSources } from "../version-diff";

const clauseVersionSummarizeParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
  versionId: tSafeId("clauseVersion"),
});

const config = {
  actionAdmission: { type: "handler", actionKind: "versions.summarize" },
  description:
    "Summarize in prose what changed between one stored clause version and " +
    "the clause's current body, over the same diff clauses.versions.diff " +
    "returns. Returns summary null when the two are identical, skipping the " +
    "model call. Consumes AI usage.",
  permissions: { workspace: ["read"], chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "knowledge_library_admin",
    consumesServices: true,
  },
  access: "write",
  params: clauseVersionSummarizeParamsSchema,
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

/**
 * AI summary of what changed between a stored clause version and the
 * clause's current version. Both bodies are resolved server-side from
 * the IDs after the ownership check; the client never supplies diff
 * text. Returns `summary: null` when the versions are identical.
 */
const clauseVersionSummarize = createSafeRootHandler(
  config,
  async function* ({
    modelAdmission,
    scopedDb,
    session,
    params,
    safeDb,
    user,
    orgAIConfig,
    managedAIResidency,
  }) {
    const organizationId = session.activeOrganizationId;

    const sources = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await loadClauseVersionDiffSources({
            scopedDb,
            organizationId,
            clauseId: params.clauseId,
            versionId: params.versionId,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to compute version diff",
            cause,
          }),
      }),
    );

    if (sources.type === "not-found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Version not found" }),
      );
    }

    const summary = yield* Result.await(
      summarizeVersionChange({
        admission: configuredModelAdmission({ modelAdmission }),
        prevText: sources.prevText,
        currentText: sources.currentText,
        feature: "clauses.version_summary",
        orgAIConfig,
        managedAIResidency,
        organizationId,
        safeDb,
        userId: user.id,
        workspaceId: null,
      }),
    );

    return Result.ok({ summary });
  },
);

export default clauseVersionSummarize;
