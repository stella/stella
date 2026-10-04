import { Result } from "better-result";
import { and, eq, or } from "drizzle-orm";
import { t } from "elysia";

import {
  CHAT_EDIT_APPLY_MODE,
  CHAT_SKILL_DOCUMENT,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
} from "@stll/api-contract";
import { listSkillMetadata } from "@stll/skills";

import { AGENT_SKILL_SCOPES, agentSkills } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  CHAT_SKILL_AVAILABILITY_STATUS,
  resolveCallerChatSkillAvailability,
  type ChatSkillContext,
} from "@/api/handlers/chat/skill-availability/offered-tools";
import { resolvesToBuiltInSkill } from "@/api/lib/agent-skills/skills";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { loadWebSearchProvidersForOrg } from "@/api/lib/web-search/load-org-keys";

const config = {
  contentDelivery: {
    type: "none",
    reason: "Returns skill availability metadata rather than stored packages.",
  },
  // The composer menus read this beside the skill list; it names skill ids
  // and tool names only.
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  /**
   * The composer's chat, to decide over instead of the widest chat the
   * caller could open: the same inputs a send from it carries. Either none
   * of the three switches is given, or all are. The client picks which chat
   * is evaluated; access to its matter and open file is checked here.
   */
  query: t.Object({
    anonymized: t.Optional(t.BooleanString()),
    browserExtension: t.Optional(t.BooleanString()),
    /** The matters the chat draws from, as a send's `contextMatterIds`. */
    contextMatterIds: t.Optional(
      t.Array(tSafeId("workspace"), { maxItems: LIMITS.workspacesCount }),
    ),
    document: t.Optional(
      t.Union([
        t.Literal(CHAT_SKILL_DOCUMENT.file),
        t.Literal(CHAT_SKILL_DOCUMENT.draft),
        t.Literal(CHAT_SKILL_DOCUMENT.template),
      ]),
    ),
    /** The open file's entity, required with `document=file`. */
    documentId: t.Optional(tSafeId("entity")),
    /** How AI edits land; omitted means the send's default. */
    editApplyMode: t.Optional(
      t.Union([
        t.Literal(CHAT_EDIT_APPLY_MODE.manual),
        t.Literal(CHAT_EDIT_APPLY_MODE.auto),
      ]),
    ),
    /** The open file's file field, as a send's `activeFile` carries it. */
    fileFieldId: t.Optional(tSafeId("field")),
    webSearch: t.Optional(t.BooleanString()),
    /** The chat's matter; absent for a chat outside any matter. */
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
} satisfies HandlerConfig;

const VISIBLE_SKILLS_MAX =
  LIMITS.agentSkillsPerUser + LIMITS.agentSkillsTeamPerOrganization;

const badRequest = (message: string) =>
  Result.err(new HandlerError({ status: 400, message }));

/**
 * The caller's skills chat cannot offer, each with the tools it lacks.
 * Chat decides this, not the skill listing: the tool set it is decided over
 * is chat's own. `unavailable` lists the skills no chat of the caller can
 * run; the composer menus leave them out and the tools page says why. With
 * the composer's chat given, `unavailableHere` lists the skills that chat
 * cannot run although another could, with what it would have to change.
 */
export const createListUnavailableChatSkills = ({
  listBuiltInSkills = listSkillMetadata,
  loadWebSearchProviders,
}: {
  /** The shipped skills; a test swaps in declarations chat cannot meet. */
  listBuiltInSkills?: typeof listSkillMetadata;
  loadWebSearchProviders: typeof loadWebSearchProvidersForOrg;
}) =>
  createSafeRootHandler(
    config,
    async function* ({
      getAccessibleWorkspaces,
      getWorkspaceAccess,
      memberRole,
      orgAIConfig,
      managedAIResidency,
      query,
      safeDb,
      scopedDb,
      session,
      user,
    }) {
      const switches = [
        query.anonymized,
        query.browserExtension,
        query.webSearch,
      ];
      // Any field names the composer's chat; none asks about the widest.
      const asksAboutChat = Object.keys(query).length > 0;
      if (asksAboutChat && switches.includes(undefined)) {
        return badRequest(
          "anonymized, browserExtension and webSearch go together",
        );
      }
      const opensFile = query.document === CHAT_SKILL_DOCUMENT.file;
      if (opensFile !== (query.documentId !== undefined)) {
        return badRequest(
          "documentId goes with document=file, and only with it",
        );
      }
      if (!opensFile && query.fileFieldId !== undefined) {
        return badRequest("fileFieldId goes with document=file only");
      }

      let chatContext: ChatSkillContext | undefined;
      if (asksAboutChat) {
        const scope = yield* resolveChatScope({
          getWorkspaceAccess,
          workspaceId: query.workspaceId,
        });
        const workspaceId =
          scope.scope === "workspace" ? scope.workspaceId : null;
        const { contextMatterIds = [], documentId } = query;
        const usableWorkspaceIds =
          documentId === undefined && contextMatterIds.length === 0
            ? new Set<string>()
            : new Set<string>(
                (yield* Result.await(
                  Result.tryPromise(
                    async () => await getAccessibleWorkspaces(),
                  ),
                )).flatMap((workspace) =>
                  workspace.status === "deleting" ? [] : [workspace.id],
                ),
              );
        // A send refuses pinned matters the caller cannot use; so does this.
        if (!contextMatterIds.every((id) => usableWorkspaceIds.has(id))) {
          return Result.err(
            new HandlerError({
              status: 403,
              message: "contextMatterIds includes inaccessible matter",
            }),
          );
        }
        let activeFile: ChatSkillContext["activeFile"];
        if (documentId !== undefined) {
          const file = yield* Result.await(
            safeDb((tx) =>
              tx.query.entities.findFirst({
                where: { id: { eq: documentId } },
                columns: { currentVersionId: true, workspaceId: true },
              }),
            ),
          );
          if (
            file === undefined ||
            !usableWorkspaceIds.has(file.workspaceId) ||
            (workspaceId !== null && file.workspaceId !== workspaceId)
          ) {
            return Result.err(
              new HandlerError({ status: 404, message: "Document not found" }),
            );
          }
          activeFile = {
            entityId: documentId,
            // A send binds the file's current version only inside a matter.
            ...(workspaceId === null || file.currentVersionId === null
              ? {}
              : { currentVersionId: file.currentVersionId }),
            ...(query.fileFieldId === undefined
              ? {}
              : { fileFieldId: query.fileFieldId }),
          };
        }
        chatContext = {
          activeFile,
          anonymized: query.anonymized === true,
          browserExtension: query.browserExtension === true,
          contextMatterIds,
          document: query.document ?? null,
          editApplyMode: query.editApplyMode ?? DEFAULT_CHAT_EDIT_APPLY_MODE,
          webSearch: query.webSearch === true,
          workspaceId,
        };
      }

      const installedSkills = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              enabled: agentSkills.enabled,
              id: agentSkills.id,
              metadata: agentSkills.metadata,
              slug: agentSkills.slug,
            })
            .from(agentSkills)
            .where(
              and(
                eq(agentSkills.organizationId, session.activeOrganizationId),
                or(
                  eq(agentSkills.scope, AGENT_SKILL_SCOPES[0]), // "team"
                  eq(agentSkills.userId, user.id),
                ),
              ),
            )
            .limit(VISIBLE_SKILLS_MAX),
        ),
      );
      // A built-in is decided under its slug, the id the skill list gives it,
      // unless an enabled row with that slug shadows it.
      const enabledInstalledSlugs = new Set(
        installedSkills.flatMap(({ enabled, slug }) => (enabled ? [slug] : [])),
      );
      const skills = [
        ...installedSkills,
        ...listBuiltInSkills().flatMap(({ metadata, name }) =>
          resolvesToBuiltInSkill(name, enabledInstalledSlugs)
            ? [{ id: name, metadata: metadata ?? null }]
            : [],
        ),
      ];
      const availability = yield* Result.await(
        resolveCallerChatSkillAvailability({
          chatContext,
          context: {
            getAccessibleWorkspaces,
            loadWebSearchProviders,
            memberRole,
            organizationId: session.activeOrganizationId,
            orgAIConfig,
            managedAIResidency,
            safeDb,
            scopedDb,
            userId: user.id,
            userEmail: user.email,
          },
          skills,
        }),
      );

      const decisions = [...availability];
      return Result.ok({
        unavailable: decisions.flatMap(([skillId, decision]) =>
          decision.status === CHAT_SKILL_AVAILABILITY_STATUS.unavailable
            ? [{ missingTools: decision.missingTools, skillId }]
            : [],
        ),
        unavailableHere: decisions.flatMap(([skillId, decision]) =>
          decision.status === CHAT_SKILL_AVAILABILITY_STATUS.unavailableHere
            ? [
                {
                  missingTools: decision.missingTools,
                  needs: decision.needs,
                  skillId,
                },
              ]
            : [],
        ),
      });
    },
  );

const listUnavailableChatSkills = createListUnavailableChatSkills({
  loadWebSearchProviders: loadWebSearchProvidersForOrg,
});

export default listUnavailableChatSkills;
