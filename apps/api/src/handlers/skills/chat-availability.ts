import { Result } from "better-result";

import { DOCX_SUGGESTION_SURFACE } from "@stll/api-contract/chat-docx-suggestions";
import type { roles } from "@stll/permissions";

import type { SafeDb, SafeDbError, ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { resolvePastChatScope } from "@/api/handlers/chat/tools/past-chat-tools";
import { chatToolNamesForSkills } from "@/api/handlers/chat/tools/skill-tool-availability";
import {
  anySkillRequiresTools,
  resolveSkillToolAvailability,
  SKILL_TOOL_AVAILABILITY_STATUS,
  type SkillToolAvailability,
} from "@/api/lib/agent-skills/required-tools";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { getOrganizationRegistryDispatch } from "@/api/lib/business-registries/credentials";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getDisabledNativeToolSlugsFromSettingsRow } from "@/api/lib/mcp-connectors/catalog-metadata";
import { loadWebSearchProvidersForOrg } from "@/api/lib/web-search/load-org-keys";

export type ChatSkillAvailabilityContext = {
  getAccessibleWorkspaces: () => Promise<AccessibleWorkspace[]>;
  memberRole: { role: keyof typeof roles };
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
};

const INERT_AUDIT_RECORDER: AuditRecorder = async () => await Promise.resolve();

const AVAILABLE: SkillToolAvailability = {
  status: SKILL_TOOL_AVAILABILITY_STATUS.available,
};

/**
 * The tools a new chat of this caller offers: the organization's native-tool
 * settings, web-search and business-register reach, and every matter the
 * caller can use, in the default (non-anonymized) mode with no document open.
 * A chat that narrows this at send time (anonymized mode, a tool scope) is
 * decided again by the turn, over its own tool set.
 */
const loadNewChatToolNames = async ({
  getAccessibleWorkspaces,
  memberRole,
  organizationId,
  orgAIConfig,
  safeDb,
  scopedDb,
  userId,
}: ChatSkillAvailabilityContext): Promise<
  Result<ReadonlySet<string>, HandlerError<500> | SafeDbError>
> => {
  const settings = await safeDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: { nativeToolOverrides: true, practiceJurisdictions: true },
    }),
  );
  if (Result.isError(settings)) {
    return Result.err(settings.error);
  }
  const loaded = await Result.tryPromise({
    try: async () =>
      await Promise.all([
        getAccessibleWorkspaces(),
        scopedDb(
          async (tx) => await loadWebSearchProvidersForOrg(tx, organizationId),
        ),
        getOrganizationRegistryDispatch({ organizationId, scopedDb }),
      ]),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to load the chat tools that decide skill availability",
        cause,
      }),
  });
  if (Result.isError(loaded)) {
    return Result.err(loaded.error);
  }
  const [workspaces, webSearchProviders, registryDispatch] = loaded.value;
  const usableWorkspaces = workspaces.filter(
    (workspace) => workspace.status !== "deleting",
  );

  return Result.ok(
    chatToolNamesForSkills({
      // Built for tool names only: no tool here ever runs, so the thread id
      // is a fresh one no thread uses and the recorders are inert.
      threadId: createSafeId<"chatThread">(),
      recordAuditEvent: INERT_AUDIT_RECORDER,
      recordReadAuditEvent: INERT_AUDIT_RECORDER,
      resolveMemorySourceWorkspaceIds: () => [],
      disabledNativeToolSlugs: getDisabledNativeToolSlugsFromSettingsRow(
        settings.value,
      ),
      docxSuggestionSurface: DOCX_SUGGESTION_SURFACE.fileOverlay,
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      memberRole: memberRole.role,
      organizationId,
      orgAIConfig,
      pastChatScope: resolvePastChatScope({
        contextMatterIds: [],
        threadWorkspaceId: null,
      }),
      pinServerValidatedWorkspaceId: () => false,
      refRegistry: createChatRefRegistry(),
      registryDispatch,
      requestWorkspaceId: null,
      safeDb,
      scopedDb,
      thirdPartyBoundary: { type: "raw" },
      toolDefectMemo: createChatToolDefectMemo(),
      toolWorkspaceIds: resolveToolWorkspaceIds({
        accessibleWorkspaceIds: usableWorkspaces.map(({ id }) => id),
        pinnedIds: [],
      }),
      userId,
      // The per-chat web-search switch is the user's to turn on; the
      // deployment, organization and provider gates still apply.
      webSearchEnabled: true,
      webSearchProviders,
      workspaceId: null,
      workspaceStatusById: new Map(
        usableWorkspaces.map(({ id, status }) => [id, status]),
      ),
    }),
  );
};

/**
 * Whether each skill can finish in this caller's chat, keyed by skill id.
 * Resolves the chat's tools only when some skill declares required tools.
 */
export const resolveCallerChatSkillAvailability = async <
  TSkill extends {
    id: string;
    metadata: Readonly<Record<string, string>> | null;
  },
>({
  context,
  skills,
}: {
  context: ChatSkillAvailabilityContext;
  skills: readonly TSkill[];
}): Promise<
  Result<
    ReadonlyMap<string, SkillToolAvailability>,
    HandlerError<500> | SafeDbError
  >
> => {
  if (!anySkillRequiresTools(skills)) {
    return Result.ok(new Map(skills.map(({ id }) => [id, AVAILABLE])));
  }
  const offered = await loadNewChatToolNames(context);
  if (Result.isError(offered)) {
    return Result.err(offered.error);
  }
  return Result.ok(
    new Map(
      skills.map((skill) => [
        skill.id,
        resolveSkillToolAvailability({
          metadata: skill.metadata,
          offeredToolNames: offered.value,
        }),
      ]),
    ),
  );
};
