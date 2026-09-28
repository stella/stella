import { Result } from "better-result";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  CHAT_EDIT_APPLY_MODE,
  CHAT_SKILL_CONTEXT_NEED,
  CHAT_SKILL_DOCUMENT,
  type ChatEditApplyMode,
  type ChatSkillContextNeed,
  type ChatSkillDocument,
} from "@stll/api-contract";
import type { roles } from "@stll/permissions";

import type { SafeDb, SafeDbError, ScopedDb } from "@/api/db/safe-db";
import { resolveBrowserClientCapability } from "@/api/handlers/chat/chat-schema";
import { createChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { resolveChatDocumentClients } from "@/api/handlers/chat/tools/chat-document-clients";
import { resolvePastChatScope } from "@/api/handlers/chat/tools/past-chat-tools";
import { chatToolNamesForSkills } from "@/api/handlers/chat/tools/skill-tool-availability";
import {
  anySkillRequiresTools,
  resolveSkillToolAvailability,
  SKILL_TOOL_AVAILABILITY_STATUS,
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
import type { loadWebSearchProvidersForOrg } from "@/api/lib/web-search/load-org-keys";
import { anonymizeTextFields } from "@/api/mcp/anonymization";

export type ChatSkillAvailabilityContext = {
  getAccessibleWorkspaces: () => Promise<AccessibleWorkspace[]>;
  /** The loader a send uses (`createSendMessage`'s dependency). */
  loadWebSearchProviders: typeof loadWebSearchProvidersForOrg;
  memberRole: { role: keyof typeof roles };
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
};

/**
 * The chat a composer is in, as far as its tool set depends on it. Each
 * field is one of a send request's inputs: its send mode, the thread's
 * web-search switch, the document it carries and how AI edits to it land,
 * its matter and whether the browser extension answered. The matter and the
 * open file have already been authorized.
 */
export type ChatSkillContext = {
  /** The open file, as a send's `activeFile` reaches the tool set. */
  activeFile?:
    | {
        currentVersionId?: SafeId<"entityVersion"> | undefined;
        entityId: SafeId<"entity">;
        fileFieldId?: SafeId<"field"> | undefined;
      }
    | undefined;
  anonymized: boolean;
  browserExtension: boolean;
  document: ChatSkillDocument | null;
  editApplyMode: ChatEditApplyMode;
  webSearch: boolean;
  workspaceId: SafeId<"workspace"> | null;
};

export const CHAT_SKILL_AVAILABILITY_STATUS = {
  available: "available",
  /** No chat of this caller has the skill's tools. */
  unavailable: "unavailable",
  /** The widest chat has them; the chat asked about does not. */
  unavailableHere: "unavailable_here",
} as const;

export type ChatSkillAvailability =
  | { status: typeof CHAT_SKILL_AVAILABILITY_STATUS.available }
  | {
      status: typeof CHAT_SKILL_AVAILABILITY_STATUS.unavailable;
      missingTools: readonly string[];
    }
  | {
      status: typeof CHAT_SKILL_AVAILABILITY_STATUS.unavailableHere;
      missingTools: readonly string[];
      /** What the chat would have to change, in `CONTEXT_NEED_ORDER`. */
      needs: readonly ChatSkillContextNeed[];
    };

const AVAILABLE: ChatSkillAvailability = {
  status: CHAT_SKILL_AVAILABILITY_STATUS.available,
};

const INERT_AUDIT_RECORDER: AuditRecorder = async () => await Promise.resolve();

type CallerChatToolInputs = {
  context: ChatSkillAvailabilityContext;
  disabledNativeToolSlugs: ReturnType<
    typeof getDisabledNativeToolSlugsFromSettingsRow
  >;
  registryDispatch: Awaited<ReturnType<typeof getOrganizationRegistryDispatch>>;
  webSearchProviders: Awaited<ReturnType<typeof loadWebSearchProvidersForOrg>>;
  workspaces: readonly AccessibleWorkspace[];
};

/** The caller's inputs every chat of theirs shares, loaded once. */
const loadCallerChatToolInputs = async (
  context: ChatSkillAvailabilityContext,
): Promise<Result<CallerChatToolInputs, HandlerError<500> | SafeDbError>> => {
  const { organizationId, safeDb, scopedDb } = context;
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
        context.getAccessibleWorkspaces(),
        scopedDb(
          async (tx) =>
            await context.loadWebSearchProviders(tx, organizationId),
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
  return Result.ok({
    context,
    disabledNativeToolSlugs: getDisabledNativeToolSlugsFromSettingsRow(
      settings.value,
    ),
    registryDispatch,
    webSearchProviders,
    workspaces,
  });
};

/**
 * The tool names a chat with `chatContext` offers, built by the same
 * `getChatTools` a send runs, from the inputs a send in that chat passes it.
 * No tool here ever runs: the thread id is a fresh one no thread uses, the
 * recorders are inert, and the anonymized boundary loads nothing.
 */
const chatContextToolNames = (
  inputs: CallerChatToolInputs,
  chatContext: ChatSkillContext,
): ReadonlySet<string> => {
  const { context, workspaces } = inputs;
  const threadId = createSafeId<"chatThread">();
  const hasOpenFile = chatContext.document === CHAT_SKILL_DOCUMENT.file;
  const usableWorkspaceIds = workspaces.flatMap((workspace) =>
    workspace.status === "deleting" ? [] : [workspace.id],
  );
  return chatToolNamesForSkills({
    threadId,
    recordAuditEvent: INERT_AUDIT_RECORDER,
    recordReadAuditEvent: INERT_AUDIT_RECORDER,
    resolveMemorySourceWorkspaceIds: () => [],
    disabledNativeToolSlugs: inputs.disabledNativeToolSlugs,
    browserClient: resolveBrowserClientCapability(
      chatContext.browserExtension
        ? { protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION }
        : undefined,
    ),
    activeFile:
      hasOpenFile && chatContext.activeFile !== undefined
        ? { ...chatContext.activeFile, supportsDocxEdits: true }
        : undefined,
    ...resolveChatDocumentClients({
      activeFileSupportsDocxEdits: hasOpenFile,
      hasActiveDraft: chatContext.document === CHAT_SKILL_DOCUMENT.draft,
      hasActiveTemplate: chatContext.document === CHAT_SKILL_DOCUMENT.template,
    }),
    editApplyMode: chatContext.editApplyMode,
    memberRole: context.memberRole.role,
    organizationId: context.organizationId,
    orgAIConfig: context.orgAIConfig,
    pastChatScope: resolvePastChatScope({
      contextMatterIds: [],
      threadWorkspaceId: chatContext.workspaceId,
    }),
    pinServerValidatedWorkspaceId: () => false,
    refRegistry: createChatRefRegistry(),
    registryDispatch: inputs.registryDispatch,
    requestWorkspaceId: chatContext.workspaceId,
    safeDb: context.safeDb,
    scopedDb: context.scopedDb,
    thirdPartyBoundary: createChatThirdPartyBoundary({
      // Injecting the anonymizer skips the gazetteer and allowlist loads a
      // boundary that anonymizes real text needs; only its type matters to
      // which tools register.
      anonymizeFields: anonymizeTextFields,
      anonymizationScopeId: chatContext.workspaceId ?? threadId,
      organizationId: context.organizationId,
      scopedDb: context.scopedDb,
      sendMode: chatContext.anonymized
        ? CHAT_SEND_MODE.anonymized
        : CHAT_SEND_MODE.rawOverride,
      threadRestorations: [],
      workspaceId: chatContext.workspaceId ?? undefined,
    }),
    toolDefectMemo: createChatToolDefectMemo(),
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: usableWorkspaceIds,
      pinnedIds: [],
    }),
    userId: context.userId,
    webSearchEnabled: chatContext.webSearch,
    webSearchProviders: inputs.webSearchProviders,
    workspaceId: chatContext.workspaceId,
    workspaceStatusById: new Map(
      workspaces.map(({ id, status }) => [id, status]),
    ),
  });
};

/**
 * The widest chat this caller can open: raw send mode, web search on (the
 * deployment, organization and provider gates still apply), a document open
 * in the editor with AI edits queued for review, an active matter and the
 * browser extension connected.
 */
const widestChatContext = (
  workspaces: readonly AccessibleWorkspace[],
): ChatSkillContext => ({
  anonymized: false,
  browserExtension: true,
  document: CHAT_SKILL_DOCUMENT.file,
  editApplyMode: CHAT_EDIT_APPLY_MODE.manual,
  webSearch: true,
  workspaceId: workspaces.find(({ status }) => status === "active")?.id ?? null,
});

/** The order needs are reported in, which is the order the web shows them. */
const CONTEXT_NEED_ORDER = [
  CHAT_SKILL_CONTEXT_NEED.rawSendMode,
  CHAT_SKILL_CONTEXT_NEED.webSearch,
  CHAT_SKILL_CONTEXT_NEED.document,
  CHAT_SKILL_CONTEXT_NEED.reviewEdits,
  CHAT_SKILL_CONTEXT_NEED.matter,
  CHAT_SKILL_CONTEXT_NEED.browserExtension,
] as const satisfies readonly ChatSkillContextNeed[];

/**
 * Each need `chatContext` has against the widest chat, with the one change
 * that meets it.
 */
const contextNeeds = ({
  chatContext,
  widest,
  workspaces,
}: {
  chatContext: ChatSkillContext;
  widest: ChatSkillContext;
  workspaces: readonly AccessibleWorkspace[];
}): ReadonlyMap<ChatSkillContextNeed, Partial<ChatSkillContext>> => {
  const matterStatus =
    chatContext.workspaceId === null
      ? undefined
      : workspaces.find(({ id }) => id === chatContext.workspaceId)?.status;
  const unmet = {
    [CHAT_SKILL_CONTEXT_NEED.rawSendMode]: chatContext.anonymized
      ? { anonymized: false }
      : null,
    [CHAT_SKILL_CONTEXT_NEED.webSearch]: chatContext.webSearch
      ? null
      : { webSearch: true },
    // A composer without a document has no edit mode of its own; opening
    // one brings the review queue. An open document keeps its mode.
    [CHAT_SKILL_CONTEXT_NEED.document]:
      chatContext.document === widest.document
        ? null
        : {
            document: widest.document,
            editApplyMode:
              chatContext.document === null
                ? widest.editApplyMode
                : chatContext.editApplyMode,
          },
    [CHAT_SKILL_CONTEXT_NEED.reviewEdits]:
      chatContext.document !== null &&
      chatContext.editApplyMode !== widest.editApplyMode
        ? { editApplyMode: widest.editApplyMode }
        : null,
    [CHAT_SKILL_CONTEXT_NEED.matter]:
      widest.workspaceId !== null && matterStatus !== "active"
        ? { workspaceId: widest.workspaceId }
        : null,
    [CHAT_SKILL_CONTEXT_NEED.browserExtension]: chatContext.browserExtension
      ? null
      : { browserExtension: true },
  } satisfies Record<ChatSkillContextNeed, Partial<ChatSkillContext> | null>;
  return new Map(
    CONTEXT_NEED_ORDER.flatMap((need) => {
      const change = unmet[need];
      return change === null ? [] : [[need, change] as const];
    }),
  );
};

/**
 * Decides the skills `chatContext` cannot run although the widest chat can,
 * and which of its needs would let each run. A need is named when meeting it
 * alone supplies one of the skill's missing tools; when the named needs
 * together still leave a tool missing (a tool that needs two changes at
 * once), every unmet need is named.
 */
const createNeedsResolver = ({
  chatContext,
  inputs,
  needs,
}: {
  chatContext: ChatSkillContext;
  inputs: CallerChatToolInputs;
  needs: ReadonlyMap<ChatSkillContextNeed, Partial<ChatSkillContext>>;
}) => {
  const namesWith = new Map<string, ReadonlySet<string>>();
  const toolNamesWith = (
    chosen: readonly ChatSkillContextNeed[],
  ): ReadonlySet<string> => {
    const key = chosen.join(",");
    const cached = namesWith.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const widened: ChatSkillContext = { ...chatContext };
    for (const need of chosen) {
      Object.assign(widened, needs.get(need));
    }
    const names = chatContextToolNames(inputs, widened);
    namesWith.set(key, names);
    return names;
  };
  const allNeeds = [...needs.keys()];
  return (missingTools: readonly string[]): ChatSkillContextNeed[] => {
    const named = allNeeds.filter((need) => {
      const names = toolNamesWith([need]);
      return missingTools.some((tool) => names.has(tool));
    });
    if (named.length === 0) {
      return allNeeds;
    }
    const namesWithNamed = toolNamesWith(named);
    return missingTools.every((tool) => namesWithNamed.has(tool))
      ? named
      : allNeeds;
  };
};

/**
 * Whether each skill can finish in this caller's chat, keyed by skill id.
 * Without `chatContext` the question is the widest chat the caller could
 * open; with it, a skill the widest chat can run but `chatContext` cannot is
 * `unavailable_here`, naming what that chat would have to change. Resolves
 * the chat tools only when some skill declares required tools.
 */
export const resolveCallerChatSkillAvailability = async ({
  chatContext,
  context,
  skills,
}: {
  chatContext?: ChatSkillContext | undefined;
  context: ChatSkillAvailabilityContext;
  skills: readonly {
    id: string;
    metadata: Readonly<Record<string, string>> | null;
  }[];
}): Promise<
  Result<
    ReadonlyMap<string, ChatSkillAvailability>,
    HandlerError<500> | SafeDbError
  >
> => {
  if (!anySkillRequiresTools(skills)) {
    return Result.ok(new Map(skills.map(({ id }) => [id, AVAILABLE])));
  }
  const inputs = await loadCallerChatToolInputs(context);
  if (Result.isError(inputs)) {
    return Result.err(inputs.error);
  }
  const widest = widestChatContext(inputs.value.workspaces);
  const widestNames = chatContextToolNames(inputs.value, widest);
  const hereNames =
    chatContext === undefined
      ? widestNames
      : chatContextToolNames(inputs.value, chatContext);
  const resolveNeeds =
    chatContext === undefined
      ? () => []
      : createNeedsResolver({
          chatContext,
          inputs: inputs.value,
          needs: contextNeeds({
            chatContext,
            widest,
            workspaces: inputs.value.workspaces,
          }),
        });

  return Result.ok(
    new Map(
      skills.map((skill): [string, ChatSkillAvailability] => {
        const everywhere = resolveSkillToolAvailability({
          metadata: skill.metadata,
          offeredToolNames: widestNames,
        });
        if (everywhere.status === SKILL_TOOL_AVAILABILITY_STATUS.unavailable) {
          return [
            skill.id,
            {
              missingTools: everywhere.missingTools,
              status: CHAT_SKILL_AVAILABILITY_STATUS.unavailable,
            },
          ];
        }
        const here = resolveSkillToolAvailability({
          metadata: skill.metadata,
          offeredToolNames: hereNames,
        });
        if (here.status === SKILL_TOOL_AVAILABILITY_STATUS.available) {
          return [skill.id, AVAILABLE];
        }
        return [
          skill.id,
          {
            missingTools: here.missingTools,
            needs: resolveNeeds(here.missingTools),
            status: CHAT_SKILL_AVAILABILITY_STATUS.unavailableHere,
          },
        ];
      }),
    ),
  );
};
