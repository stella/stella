import { useMemo, useRef, useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createFileRoute,
  getRouteApi,
  Link,
  useNavigate,
} from "@tanstack/react-router";
import { Result } from "better-result";
import {
  BookOpenIcon,
  HistoryIcon,
  MessageSquareIcon,
  Minimize2Icon,
  PinIcon,
  PlusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  LANDING_ROW_CLASS,
  LANDING_SECTION_HEADING_CLASS,
  LandingButton,
  LandingEmpty,
  LandingGreeting,
  LandingItemText,
  LandingLayout,
  LandingSection,
} from "@stll/ui/landing";
import { stellaToast } from "@stll/ui/toast";

import {
  ChatSubmitPreservedError,
  useChatEditor,
} from "@/components/chat-editor-provider";
import type { ChatInputDraft } from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { ChatThreadOriginPrefix } from "@/components/chat/chat-thread-origin-prefix";
import { useChatModelSelection } from "@/components/chat/use-chat-model-selection";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterIcon } from "@/components/matter-icon";
import { useAIKeyGate } from "@/components/require-ai-key";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { MatterContextMenu } from "@/components/workspaces/matter-context-menu";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { useChatDraftMeta } from "@/features/chat/hooks/use-chat-draft-meta";
import { useChatUserContext } from "@/features/chat/hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/features/chat/lib/build-chat-request-message";
import { startNewThreadCommandHandoff } from "@/features/chat/lib/start-new-thread-command-handoff";
import {
  acquireChatRuntime,
  applyChatModelChange,
  chatThreadOptions,
  groupedChatThreadsOptions,
  invalidateGroupedChatThreads,
  listChatHistoryItems,
  mergeGroupedChatThreadPages,
} from "@/features/chat/queries";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import { getAnalytics, useAnalytics } from "@/lib/analytics/provider";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { api } from "@/lib/api";
import {
  getChatSendMode,
  useChatAnonymized,
} from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { createChatThreadId, getChatThreadKey } from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { useChatWebSearchPreferenceStore } from "@/lib/chat-web-search-store";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { skillsOptions } from "@/lib/knowledge/queries";
import { usePinnedStore } from "@/lib/pinned-store";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import {
  prefetchNonCriticalInfiniteQuery,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { formatRelativeTime } from "@/lib/relative-time";
import { runReservedChatCommand } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";

export const Route = createFileRoute("/_protected/chat/")({
  loader: ({ context }) => {
    const activeOrganizationId = context.user.activeOrganizationId;
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error);
    };

    detached(
      Promise.all([
        prefetchRouteQuery(
          context.queryClient,
          workspacesNavigationOptions(activeOrganizationId),
          onPrefetchError,
        ),
        prefetchNonCriticalInfiniteQuery(
          context.queryClient,
          groupedChatThreadsOptions({ activeOrganizationId }),
          onPrefetchError,
        ),
        prefetchNonCriticalInfiniteQuery(
          context.queryClient,
          skillsOptions(activeOrganizationId),
          onPrefetchError,
        ),
      ]),
      "chat-index.prefetch",
    );
  },
  component: ChatIndex,
});

const protectedRouteApi = getRouteApi("/_protected");

function ChatIndex() {
  const t = useTranslations();
  const { ensureAIAvailable } = useAIKeyGate();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();
  const getUserContext = useLatestCallback(() => userContext);
  const threadIdRef = useRef<ChatThreadRef["threadId"] | null>(null);
  threadIdRef.current ??= createChatThreadId();
  // `/new` rotates the ref above; bump a render so `threadRef` (and the
  // composer bound to it via `useChatEditor`) rebind to the fresh id instead
  // of staying on the abandoned draft.
  const [, rotateDraftThread] = useState(0);
  // eslint-disable-next-line react/refs -- draft-thread identity held in a ref and rotated imperatively (each rotation is paired with rotateDraftThread to force the dependent render); reading the current id here to derive this render's threadRef and query key is intentional
  const draftThreadId = threadIdRef.current;
  const threadRef: ChatThreadRef = {
    scope: "global",
    threadId: draftThreadId,
  };
  const controller = useChatEditor({
    threadRef,
  });
  const prompts = useSavedPrompts();
  const pinnedOrder = usePinnedStore((s) => s.pinnedOrder);
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: workspacesData } = useQuery(
    workspacesNavigationOptions(activeOrganizationId),
  );
  const workspaces = workspacesData?.workspaces;
  const { data: groupedThreadPages } = useInfiniteQuery(
    groupedChatThreadsOptions({ activeOrganizationId }),
  );
  const groupedThreads = useMemo(
    () => mergeGroupedChatThreadPages(groupedThreadPages?.pages),
    [groupedThreadPages?.pages],
  );
  const anonymized = useChatAnonymized(threadRef);
  const [composerFocused, setComposerFocused] = useState(false);
  const getSendMode = useLatestCallback(() => getChatSendMode(threadRef));
  const openInspectorChat = useInspectorTabsStore((s) => s.openChat);
  const [contextMatterIds, setContextMatterIds] = useState<string[]>([]);
  const getContextMatterIds = useLatestCallback(() => contextMatterIds);
  const { draftMeta: chatDraftMeta, draftMetaQueryKey } = useChatDraftMeta({
    activeOrganizationId,
    threadRef,
  });

  // Persists the composer's Models submenu selection and gates the
  // route-handoff send below on the outcome (see `onSubmit`) so a send can
  // never race a just-changed model onto the thread's previous one. Same
  // hook `ChatThreadPage` uses; keeps both surfaces' sequencing identical.
  const modelSelection = useChatModelSelection({
    onPersisted: ({ model, reasoningEffort }) => {
      applyChatModelChange({
        model,
        reasoningEffort,
        queryClient,
        queryKey: draftMetaQueryKey,
        threadId: toSafeId<"chatThread">(draftThreadId),
      });
    },
    threadRef,
  });

  // Mirror the per-thread seeding from ChatThreadPage: if the user
  // previously enabled web search and the draft thread doesn't have
  // it on, PATCH it on. Marks seeded only on success so a transient
  // failure can retry on the next render.
  const enabledPreference = useChatWebSearchPreferenceStore(
    (state) => state.enabledPreference,
  );
  const analytics = useAnalytics();
  const { mutate: seedDraftWebSearch } = useMutation({
    mutationFn: async () => {
      const response = await api.chat
        .threads({
          threadId: toSafeId<"chatThread">(
            threadIdRef.current ?? createChatThreadId(),
          ),
        })
        .patch({ webSearchEnabled: true }, { query: {} });
      return unwrapEden(response);
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
  const seededDraftRef = useRef<string | null>(null);
  const seedingDraftRef = useRef<string | null>(null);
  useExternalSyncEffect(() => {
    const threadId = threadIdRef.current;
    if (
      threadId === null ||
      seededDraftRef.current === threadId ||
      seedingDraftRef.current === threadId
    ) {
      return;
    }
    if (
      enabledPreference &&
      chatDraftMeta?.webSearchAvailable &&
      !chatDraftMeta.webSearchEnabled
    ) {
      seedingDraftRef.current = threadId;
      seedDraftWebSearch(undefined, {
        onSuccess: () => {
          if (seedingDraftRef.current === threadId) {
            seedingDraftRef.current = null;
          }
          seededDraftRef.current = threadId;
          detached(
            queryClient.invalidateQueries({
              queryKey: chatKeys.draftMeta(activeOrganizationId, {
                scope: "global",
                threadId,
              }),
            }),
            "chat.invalidate",
          );
        },
        onError: () => {
          if (seedingDraftRef.current === threadId) {
            seedingDraftRef.current = null;
          }
        },
      });
    }
  }, [
    activeOrganizationId,
    chatDraftMeta?.webSearchAvailable,
    chatDraftMeta?.webSearchEnabled,
    enabledPreference,
    queryClient,
    seedDraftWebSearch,
  ]);

  const pinnedMatters = useMemo(() => {
    const workspaceById = new Map<string, PinnedMatter>();
    if (workspaces) {
      for (const workspace of workspaces) {
        workspaceById.set(workspace.id, {
          color: workspace.color,
          id: workspace.id,
          lastActivityAt: workspace.lastActivityAt,
          name: workspace.name,
          client: workspace.client,
        });
      }
    }
    const matters: PinnedMatter[] = [];
    for (const workspaceId of pinnedOrder) {
      const workspace = workspaceById.get(workspaceId);
      if (workspace) {
        matters.push(workspace);
      }
    }
    return matters.slice(0, 5);
  }, [pinnedOrder, workspaces]);

  const lastAccessedMatters = useMemo(() => {
    if (!workspaces) {
      return [];
    }
    return workspaces
      .toSorted(
        (left, right) =>
          new Date(right.lastActivityAt).getTime() -
          new Date(left.lastActivityAt).getTime(),
      )
      .slice(0, 5)
      .map((workspace) => ({
        color: workspace.color,
        id: workspace.id,
        lastActivityAt: workspace.lastActivityAt,
        name: workspace.name,
        client: workspace.client,
      }));
  }, [workspaces]);

  const visibleMatters =
    pinnedMatters.length > 0 ? pinnedMatters : lastAccessedMatters;
  const mattersHeading =
    pinnedMatters.length > 0
      ? t("chat.landing.pinnedMatters")
      : t("chat.landing.lastAccessedMatters");

  const recentChats = useMemo(
    () => listChatHistoryItems(groupedThreads).slice(0, 5),
    [groupedThreads],
  );

  const selectPrompt = (prompt: ChatPrompt) => {
    controller.setContent(prompt.body);
    controller.focus();
  };

  const moveToSide = () => {
    openInspectorChat({
      id: threadIdRef.current ?? createChatThreadId(),
      contextMatterIds,
    });
    detached(navigate({ to: "/chat" }), "chat.navigate");
  };

  const handleSubmit = async (draft: ChatInputDraft) => {
    const newThreadMessages: string[] = [];
    const handledReserved = runReservedChatCommand(draft.html, {
      new: (args) => {
        if (args.length > 0) {
          newThreadMessages.push(args);
          return;
        }
        controller.setContent("");
        threadIdRef.current = createChatThreadId();
        rotateDraftThread((value) => value + 1);
      },
      "rename-chat": () => {
        // Nothing persisted to rename yet: this composer only ever holds an
        // unsent draft thread. Explain instead of silently no-oping.
        controller.setContent("");
        stellaToast.add({
          title: t("chat.renameUnavailableEmptyThread"),
          type: "info",
        });
      },
    });
    if (handledReserved) {
      const newThreadMessage = newThreadMessages.at(0);
      if (newThreadMessage === undefined) {
        return;
      }
      if (!(await ensureAIAvailable())) {
        throw new ChatSubmitPreservedError({ message: "AI is unavailable" });
      }
      if (Result.isError(await modelSelection.awaitPendingSelection())) {
        throw new ChatSubmitPreservedError({
          message: "Model selection failed",
        });
      }
      const chatThreadContext = {
        allowMissingThread: true,
        getUserContext,
        getContextMatterIds,
        getSendMode,
      };
      await startNewThreadCommandHandoff({
        activeOrganizationId,
        context: chatThreadContext,
        files: draft.files,
        html: newThreadMessage,
        queryClient,
        threadRef,
      });
      await navigate({
        to: "/chat/$threadId",
        params: { threadId: threadRef.threadId },
      });
      detached(
        invalidateGroupedChatThreads(queryClient),
        "chat.invalidate-grouped-chat-threads",
      );
      return;
    }
    if (!(await ensureAIAvailable())) {
      return;
    }
    // A model just picked in the (+) menu may still be
    // mid-PATCH: wait for it to settle so the route-handoff
    // send below can never race onto the thread's previous
    // model, which is worst here since a brand-new draft
    // thread has no persisted model until this PATCH lands. On
    // failure the hook has already toasted; abort instead of
    // sending with a model that may not match what the server
    // has persisted.
    if (Result.isError(await modelSelection.awaitPendingSelection())) {
      return;
    }
    // Build the request payload and fetch the pure thread data
    // in parallel, then resolve (and register) the Chat<>
    // runtime from this component's own live getters; the
    // thread route resolves the *same* registered runtime (see
    // `acquireChatRuntime` — this context carries the exact
    // capability set ChatThreadPage passes, so both map to
    // the same registry fingerprint), and kicking off the
    // send here lets the thread page observe the in-flight
    // stream as soon as it mounts. The stream started below
    // also makes the runtime BUSY before the destination
    // page's acquire runs, so its idle-reconcile can never
    // rebuild the handoff runtime out from under the live
    // stream — it always takes the mid-stream reattach
    // branch. The runtime keeps THIS page's getters until the
    // turn's onFinish invalidation refetches the thread
    // query; the destination page's post-refetch acquire then
    // sees the diverged seed signal and rebuilds with its own
    // getters.
    const chatThreadContext = {
      allowMissingThread: true,
      getUserContext,
      getContextMatterIds,
      getSendMode,
    };
    const [message, threadData] = await Promise.all([
      buildChatRequestMessage(draft),
      queryClient.query({
        ...chatThreadOptions({
          activeOrganizationId,
          key: threadRef,
          context: chatThreadContext,
        }),
        staleTime: "static",
      }),
    ]);
    const chat = acquireChatRuntime({
      activeOrganizationId,
      context: chatThreadContext,
      data: threadData,
      key: threadRef,
      queryClient,
    });

    // Start the stream before navigation and require
    // the user message to be locally visible. If the
    // TanStack boundary fails before appending, this
    // throws here so the composer restores the draft
    // instead of navigating to an empty thread.
    chat.startRouteHandoffMessage(message);

    await navigate({
      to: "/chat/$threadId",
      params: {
        threadId: threadIdRef.current ?? createChatThreadId(),
      },
    });
    detached(
      invalidateGroupedChatThreads(queryClient),
      "chat.invalidate-grouped-chat-threads",
    );
  };

  return (
    <LandingLayout
      actions={
        <ChromeHeaderActions>
          <Tooltip
            content={t("chat.moveToSide")}
            render={
              <Button onClick={moveToSide} size="icon-sm" variant="ghost">
                <Minimize2Icon className="size-4" />
              </Button>
            }
          />
          <ThreadsSheet />
        </ChromeHeaderActions>
      }
      hero={
        <>
          <LandingGreeting icon={<StellaMark className="size-7" />}>
            {t("chat.greeting")}
          </LandingGreeting>
          <div className="w-full">
            <ChatAnonymizationLayer
              editor={controller.editor}
              enabled={anonymized}
              focused={composerFocused}
              ownerKey={getChatThreadKey(threadRef)}
              workspaceId={draftThreadId}
            />
            <ChatInputSurface
              anonymized={anonymized}
              autoFocus
              context={{ activeOrganizationId, threadRef }}
              controller={controller}
              guideAnchorsEnabled
              variant="large"
              mcpOrganizationId={activeOrganizationId}
              models={{
                activeOrganizationId,
                threadRef,
                selectedModel: chatDraftMeta?.model ?? null,
                selectedReasoningEffort: chatDraftMeta?.reasoningEffort ?? null,
                selectModel: modelSelection.selectModel,
              }}
              reservedCommands={{ hasPersistedThread: false }}
              skillsOrganizationId={activeOrganizationId}
              dock={
                <ChatComposerDock
                  data={{
                    webSearchAvailable:
                      chatDraftMeta?.webSearchAvailable ?? false,
                    webSearchEnabled: chatDraftMeta?.webSearchEnabled ?? false,
                    // The draft carries the same cache-stable floor its first
                    // send will pay, so the meter shows the honest baseline
                    // (~system prompt + tools) rather than 0% until send.
                    context: chatDraftMeta?.context ?? null,
                  }}
                  guideAnchorsEnabled
                  models={{
                    activeOrganizationId,
                    threadRef,
                    selectedModel: chatDraftMeta?.model ?? null,
                    selectedReasoningEffort:
                      chatDraftMeta?.reasoningEffort ?? null,
                    selectModel: modelSelection.selectModel,
                  }}
                  leadingContext={
                    <ChatMatterPicker
                      matterIds={contextMatterIds}
                      onChange={setContextMatterIds}
                    />
                  }
                  // The hero already IS a fresh thread; a new-chat
                  // affordance here would be a no-op, so opt out.
                  onNewThread={null}
                  threadRef={threadRef}
                />
              }
              onSubmit={handleSubmit}
              onFocusChange={setComposerFocused}
            />
          </div>
        </>
      }
    >
      <LandingSection
        heading={
          <Link className={LANDING_SECTION_HEADING_CLASS} to="/workspaces">
            {pinnedMatters.length > 0 ? (
              <PinIcon className="size-4" />
            ) : (
              <MatterIcon className="size-4" variant="all" />
            )}
            {mattersHeading}
          </Link>
        }
      >
        {visibleMatters.length > 0 ? (
          visibleMatters.map((matter) => (
            <MatterContextMenu
              className="contents"
              key={matter.id}
              target={{
                id: matter.id,
                name: matter.name,
                color: matter.color,
                client: matter.client,
              }}
            >
              <Link
                className={LANDING_ROW_CLASS}
                params={{ workspaceId: matter.id }}
                to="/workspaces/$workspaceId"
              >
                <LandingItemText
                  icon={
                    <MatterIcon
                      className="size-4"
                      matter={{ id: matter.id, color: matter.color }}
                    />
                  }
                  iconTone="matter"
                  meta={formatRelativeTime(matter.lastActivityAt)}
                  title={matter.name}
                />
              </Link>
            </MatterContextMenu>
          ))
        ) : (
          <LandingEmpty>
            <div className="flex flex-col items-start gap-2.5">
              {t("chat.landing.noMatters")}
              {canCreateMatter && (
                <Button
                  onClick={() => openCreateMatter()}
                  size="sm"
                  variant="outline"
                >
                  <PlusIcon className="size-4" />
                  {t("workspaces.createNewWorkspace")}
                </Button>
              )}
            </div>
          </LandingEmpty>
        )}
      </LandingSection>
      <LandingSection
        heading={
          <Link
            className={LANDING_SECTION_HEADING_CLASS}
            to="/knowledge/prompts"
          >
            <BookOpenIcon className="size-4" />
            {t("chat.landing.prompts")}
          </Link>
        }
      >
        {prompts.length > 0 ? (
          prompts.map((prompt) => (
            <LandingButton
              icon={<SlashPromptIcon />}
              key={prompt.id}
              meta={prompt.body}
              onClick={() => selectPrompt(prompt)}
              title={prompt.name}
            />
          ))
        ) : (
          <LandingEmpty>{t("chat.landing.noPrompts")}</LandingEmpty>
        )}
      </LandingSection>
      <LandingSection
        heading={
          <ThreadsSheet
            icon={<HistoryIcon className="size-4" />}
            label={t("chat.landing.recentChats")}
            triggerVariant="section"
          />
        }
      >
        {recentChats.length > 0 ? (
          recentChats.map((chat) =>
            chat.scope === "workspace" ? (
              <Link
                className={LANDING_ROW_CLASS}
                key={chat.id}
                params={{
                  workspaceId: chat.workspaceId,
                  threadId: chat.id,
                }}
                to="/chat/workspaces/$workspaceId/$threadId"
              >
                <LandingItemText
                  icon={<MessageSquareIcon className="size-4" />}
                  meta={
                    <>
                      <ChatThreadOriginPrefix origin={chat.origin} />
                      <BidiText>{chat.workspaceName}</BidiText>
                      {" - "}
                      {formatRelativeTime(chat.updatedAt)}
                    </>
                  }
                  title={
                    isPlaceholderThreadTitle(chat.title)
                      ? t("chat.newChat")
                      : chat.title
                  }
                />
              </Link>
            ) : (
              <Link
                className={LANDING_ROW_CLASS}
                key={chat.id}
                params={{ threadId: chat.id }}
                to="/chat/$threadId"
              >
                <LandingItemText
                  icon={<MessageSquareIcon className="size-4" />}
                  meta={
                    <>
                      <ChatThreadOriginPrefix origin={chat.origin} />
                      {formatRelativeTime(chat.updatedAt)}
                    </>
                  }
                  title={
                    isPlaceholderThreadTitle(chat.title)
                      ? t("chat.newChat")
                      : chat.title
                  }
                />
              </Link>
            ),
          )
        ) : (
          <LandingEmpty>{t("chat.landing.noRecentChats")}</LandingEmpty>
        )}
      </LandingSection>
    </LandingLayout>
  );
}

type PinnedMatter = {
  color: string | null;
  id: string;
  lastActivityAt: string | Date;
  name: string;
  /** Drives the right-click menu's add-member affordance and header. */
  client: { displayName: string } | null;
};

const SlashPromptIcon = () => (
  <span className="font-mono text-[13px] leading-none">/</span>
);
