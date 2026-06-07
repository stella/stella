import { Result } from "better-result";
import { t } from "elysia";

import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { normalizeLegacyToolInputs } from "@/api/handlers/chat/legacy-tool-compat";
import { isWebSearchAvailable } from "@/api/handlers/chat/tools/chat-tools";
import { getDisabledNativeToolSlugs } from "@/api/handlers/mcp-connectors/catalog-metadata";
import { parseUserFileId } from "@/api/handlers/user-files/types";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ChatPart = ReturnType<typeof normalizeLegacyToolInputs>[number];

/**
 * Attach the stored blur placeholder to image file parts so the client can
 * render a blur-up while the thumbnail loads. The thumbnail URL itself is
 * derived client-side from the user-file id, so only the DB-sourced
 * placeholder needs to travel with the message.
 */
const attachPlaceholders = (
  parts: ChatPart[],
  placeholderById: Map<string, string>,
): ChatPart[] =>
  parts.map((part) => {
    if (part.type !== "file") {
      return part;
    }
    const fileId = parseUserFileId(part.url);
    const placeholder = fileId ? placeholderById.get(fileId) : undefined;
    return placeholder ? { ...part, placeholder } : part;
  });

const config = {
  permissions: { chat: ["create"] },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    allowMissingThread: t.Optional(t.Boolean()),
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
} satisfies HandlerConfig;

const getMessages = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    params: { threadId },
    query: { allowMissingThread, workspaceId },
    safeDb,
    session,
    user,
  }) {
    const accessibleWorkspaceIds = activeWorkspaceIds;
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds,
      workspaceId,
    });

    const thread = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            userId: { eq: user.id },
          },
          columns: {
            workspaceId: true,
            contextMatterIds: true,
            webSearchEnabled: true,
          },
          with: {
            messages: {
              columns: {
                id: true,
                role: true,
                content: true,
                createdAt: true,
              },
              orderBy: { createdAt: "asc" },
            },
          },
        }),
      ),
    );
    const orgSettingsForChat = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: {
            practiceJurisdictions: true,
            nativeToolOverrides: true,
          },
        }),
      ),
    );
    const disabledNativeToolSlugs = getDisabledNativeToolSlugs({
      practiceJurisdictions: orgSettingsForChat?.practiceJurisdictions ?? [],
      nativeToolOverrides: orgSettingsForChat?.nativeToolOverrides ?? {},
    });
    const webSearchAvailable = isWebSearchAvailable(disabledNativeToolSlugs);

    if (!thread) {
      if (allowMissingThread) {
        return Result.ok({
          messages: [],
          contextMatterIds: [],
          lastActivityAt: null,
          webSearchAvailable,
          webSearchEnabled: false,
        });
      }

      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    // Reject requests whose scope contradicts the persisted thread.
    // A workspace-scoped thread asked for as global (or vice versa)
    // is a client bug — fail loud instead of silently 404'ing or
    // creating a duplicate.
    const persistedWorkspaceId = thread.workspaceId ?? null;
    const requestedWorkspaceId =
      scope.scope === "workspace" ? scope.workspaceId : null;
    if (persistedWorkspaceId !== requestedWorkspaceId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Chat thread scope does not match request",
        }),
      );
    }

    // Most recent message timestamp; the client compares it against
    // the recap staleness window to decide whether to ask for a recap.
    const lastActivityAt =
      thread.messages.at(-1)?.createdAt.toISOString() ?? null;

    const referencedFileIds = new Set<SafeId<"userFile">>();
    for (const row of thread.messages) {
      for (const part of row.content.data) {
        if (part.type !== "file") {
          continue;
        }
        const fileId = parseUserFileId(part.url);
        if (fileId) {
          referencedFileIds.add(fileId);
        }
      }
    }

    const placeholderById = new Map<string, string>();
    if (referencedFileIds.size > 0) {
      const fileRows = yield* Result.await(
        safeDb((tx) =>
          tx.query.userFiles.findMany({
            where: {
              id: { in: [...referencedFileIds] },
              userId: { eq: user.id },
            },
            columns: { id: true, placeholder: true },
          }),
        ),
      );
      for (const fileRow of fileRows) {
        if (fileRow.placeholder !== null) {
          placeholderById.set(fileRow.id, fileRow.placeholder);
        }
      }
    }

    return Result.ok({
      messages: thread.messages.map((row) => ({
        id: row.id,
        role: row.role,
        parts: attachPlaceholders(
          normalizeLegacyToolInputs(row.content.data),
          placeholderById,
        ),
      })),
      contextMatterIds: thread.contextMatterIds,
      lastActivityAt,
      webSearchAvailable,
      webSearchEnabled: thread.webSearchEnabled,
    });
  },
);

export default getMessages;
