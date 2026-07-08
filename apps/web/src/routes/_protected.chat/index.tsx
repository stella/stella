import { useEffectEvent, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

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
import {
  HistoryIcon,
  MessageSquareIcon,
  Minimize2Icon,
  PinIcon,
  PlusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { MatterIcon } from "@/components/matter-icon";
import { useAIKeyGate } from "@/components/require-ai-key";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { api } from "@/lib/api";
import {
  getChatSendMode,
  useChatAnonymized,
} from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { useChatWebSearchPreferenceStore } from "@/lib/chat-web-search-store";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { toAPIError } from "@/lib/errors";
import { useModelSelectorStore } from "@/lib/model-selector-store";
import { usePinnedStore } from "@/lib/pinned-store";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { formatRelativeTime } from "@/lib/relative-time";
import { matchReservedChatCommand } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
  acquireChatRuntime,
  chatThreadOptions,
  groupedChatThreadsOptions,
  invalidateGroupedChatThreads,
  mergeGroupedChatThreadPages,
} from "@/routes/_protected.chat/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { MatterContextMenu } from "@/routes/_protected.workspaces/-components/matter-context-menu";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";

export const Route = createFileRoute("/_protected/chat/")({
  component: ChatIndex,
});

const protectedRouteApi = getRouteApi("/_protected");

function ChatIndex() {
  const t = useTranslations();
  const { ensureAIAvailable } = useAIKeyGate();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const threadIdRef = useRef(createChatThreadId());
  // `/new` rotates the ref above; bump a render so `threadRef` (and the
  // composer bound to it via `useChatEditor`) rebind to the fresh id instead
  // of staying on the abandoned draft.
  const [, rotateDraftThread] = useState(0);
  // eslint-disable-next-line react/react-compiler -- draft-thread identity held in a ref and rotated imperatively (each rotation is paired with rotateDraftThread to force the dependent render); reading the current id here to derive this render's threadRef and query key is intentional
  const draftThreadId = threadIdRef.current;
  const threadRef: ChatThreadRef = {
    scope: "global",
    threadId: draftThreadId,
  };
  const controller = useChatEditor({ reservedCommands: true, threadRef });
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
    groupedChatThreadsOptions(activeOrganizationId),
  );
  const groupedThreads = useMemo(
    () => mergeGroupedChatThreadPages(groupedThreadPages?.pages),
    [groupedThreadPages?.pages],
  );
  const anonymized = useChatAnonymized(threadRef);
  const getSendMode = useEffectEvent(() => getChatSendMode(threadRef));
  const openInspectorChat = useInspectorStore((s) => s.openChat);
  const [contextMatterIds, setContextMatterIds] = useState<string[]>([]);
  const getContextMatterIds = useEffectEvent(() => contextMatterIds);
  // Standalone, non-suspense fetch of the draft thread metadata.
  // We deliberately don't reuse `chatThreadOptions` here because that
  // helper instantiates a stateful `Chat<>` inside its queryFn on
  // every miss; doing so on the chat-home render path froze the
  // tab. We only need `webSearchAvailable` + `webSearchEnabled`,
  // so a plain GET against the messages endpoint is enough.
  // Key shape mirrors `chatKeys.thread` up to position 4 so
  // `invalidateChatThread({ queryClient, threadRef })` (fired by
  // <ChatWebSearchToggle> on every PATCH) refetches us. Without
  // that match the toggle would flip server-side but the local
  // `webSearchEnabled` shown by this query would stay stale.
  const { data: chatDraftMeta } = useQuery({
    queryKey: [
      "chat",
      activeOrganizationId,
      "thread",
      "global",
      draftThreadId,
      "draftMeta",
    ] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const response = await api.chat
        .threads({ threadId: toSafeId<"chatThread">(draftThreadId) })
        .messages.get({ query: { allowMissingThread: true } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return {
        webSearchAvailable: response.data.webSearchAvailable,
        webSearchEnabled: response.data.webSearchEnabled,
      };
    },
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
        .threads({ threadId: toSafeId<"chatThread">(threadIdRef.current) })
        .patch({ webSearchEnabled: true }, { query: {} });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
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
          void queryClient.invalidateQueries({
            queryKey: [
              "chat",
              activeOrganizationId,
              "thread",
              "global",
              threadId,
              "draftMeta",
            ] as const,
          });
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
    for (const workspace of workspaces ?? []) {
      workspaceById.set(workspace.id, {
        color: workspace.color,
        id: workspace.id,
        lastActivityAt: workspace.lastActivityAt,
        name: workspace.name,
        client: workspace.client,
      });
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

  const lastAccessedMatters = useMemo(
    () =>
      (workspaces ?? [])
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
        })),
    [workspaces],
  );

  const visibleMatters =
    pinnedMatters.length > 0 ? pinnedMatters : lastAccessedMatters;
  const mattersHeading =
    pinnedMatters.length > 0
      ? t("chat.landing.pinnedMatters")
      : t("chat.landing.lastAccessedMatters");

  const recentChats = useMemo(() => {
    const threads: RecentChat[] = [];
    for (const thread of groupedThreads.global) {
      threads.push({
        scope: "global",
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
      });
    }
    for (const workspace of groupedThreads.workspaces) {
      for (const thread of workspace.threads) {
        threads.push({
          scope: "workspace",
          id: thread.id,
          title: thread.title,
          updatedAt: thread.updatedAt,
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
        });
      }
    }
    return threads
      .toSorted(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      )
      .slice(0, 5);
  }, [groupedThreads]);

  const selectPrompt = (prompt: ChatPrompt) => {
    controller.setContent(prompt.body);
    controller.focus();
  };

  const moveToSide = () => {
    openInspectorChat({
      id: threadIdRef.current,
      contextMatterIds,
    });
    void navigate({ to: "/chat" });
  };

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col overflow-hidden">
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
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pb-16">
        <div className="flex min-h-[22rem] w-full max-w-2xl shrink-0 flex-col items-center justify-center gap-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="border-border bg-background text-foreground flex size-12 items-center justify-center rounded-lg border shadow-sm">
              <StellaMark className="size-7" />
            </div>
            <p className="text-foreground max-w-md text-center text-lg font-medium">
              {t("chat.greeting")}
            </p>
          </div>
          <div className="w-full">
            <ChatAnonymizationLayer
              editor={controller.editor}
              enabled={anonymized}
              workspaceId={draftThreadId}
            />
            <ChatInputSurface
              anonymized={anonymized}
              autoFocus
              controller={controller}
              variant="large"
              onOpenMcpServers={() => {
                void navigate({
                  to: "/knowledge/tools",
                  search: { kind: "mcp" },
                });
              }}
              onOpenModelSelector={() => {
                useModelSelectorStore.getState().open();
              }}
              dock={
                <ChatComposerDock
                  data={{
                    webSearchAvailable:
                      chatDraftMeta?.webSearchAvailable ?? false,
                    webSearchEnabled: chatDraftMeta?.webSearchEnabled ?? false,
                    // No thread yet, so no context estimate: the meter
                    // stays hidden until the first send creates the row.
                    context: null,
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
              onSubmit={async (draft) => {
                const reservedCommand = matchReservedChatCommand(draft.html);
                if (reservedCommand?.id === "new") {
                  controller.setContent("");
                  threadIdRef.current = createChatThreadId();
                  rotateDraftThread((value) => value + 1);
                  return;
                }
                if (reservedCommand?.id === "model") {
                  controller.setContent("");
                  useModelSelectorStore.getState().open();
                  return;
                }

                if (!(await ensureAIAvailable())) {
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
                  queryClient.ensureQueryData(
                    chatThreadOptions({
                      activeOrganizationId,
                      key: threadRef,
                      context: chatThreadContext,
                    }),
                  ),
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
                  params: { threadId: threadIdRef.current },
                });
                void invalidateGroupedChatThreads(queryClient);
              }}
            />
          </div>
        </div>
        <div className="grid min-h-52 w-full gap-8 md:grid-cols-3">
          <LandingSection
            heading={
              <Link
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-2 rounded-md px-1 text-xs font-semibold tracking-widest uppercase transition-colors outline-none focus-visible:ring-2"
                to="/workspaces"
              >
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
                    className="group hover:bg-accent/50 focus-visible:ring-ring rounded-md px-2 py-1.5 text-start transition-colors outline-none focus-visible:ring-2"
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
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-2 rounded-md px-1 text-xs font-semibold tracking-widest uppercase transition-colors outline-none focus-visible:ring-2"
                to="/knowledge/prompts"
              >
                <SlashPromptIcon />
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
                    className="group hover:bg-accent/50 focus-visible:ring-ring rounded-md px-2 py-1.5 text-start transition-colors outline-none focus-visible:ring-2"
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
                    className="group hover:bg-accent/50 focus-visible:ring-ring rounded-md px-2 py-1.5 text-start transition-colors outline-none focus-visible:ring-2"
                    key={chat.id}
                    params={{ threadId: chat.id }}
                    to="/chat/$threadId"
                  >
                    <LandingItemText
                      icon={<MessageSquareIcon className="size-4" />}
                      meta={formatRelativeTime(chat.updatedAt)}
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
        </div>
      </div>
    </div>
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

type RecentChat =
  | {
      scope: "global";
      id: string;
      title: string;
      updatedAt: string | Date;
    }
  | {
      scope: "workspace";
      id: string;
      title: string;
      updatedAt: string | Date;
      workspaceId: string;
      workspaceName: string;
    };

type LandingSectionProps = {
  children: ReactNode;
  heading: ReactNode;
};

const LandingSection = ({ children, heading }: LandingSectionProps) => (
  <section className="min-w-0">
    <div className="mb-3">{heading}</div>
    <div className="flex flex-col gap-1">{children}</div>
  </section>
);

type LandingButtonProps = {
  icon?: ReactElement;
  meta?: ReactNode | undefined;
  onClick: () => void;
  title: ReactNode;
};

const LandingButton = ({ icon, meta, onClick, title }: LandingButtonProps) => (
  <button
    className="group hover:bg-accent/50 focus-visible:ring-ring rounded-md px-2 py-1.5 text-start transition-colors outline-none focus-visible:ring-2"
    onClick={onClick}
    type="button"
  >
    <span className="flex min-w-0 items-start gap-2">
      {icon !== undefined && <LandingRowIcon>{icon}</LandingRowIcon>}
      <span className="min-w-0 flex-1">
        <BidiText
          as="span"
          className="text-foreground block truncate text-sm font-medium"
        >
          {title}
        </BidiText>
        {meta !== undefined && meta !== null ? (
          <span className="text-muted-foreground block truncate text-xs">
            {meta}
          </span>
        ) : null}
      </span>
    </span>
  </button>
);

type LandingItemTextProps = {
  icon?: ReactElement;
  iconTone?: "muted" | "matter" | undefined;
  meta?: ReactNode | undefined;
  title: ReactNode;
};

const LandingItemText = ({
  icon,
  iconTone = "muted",
  meta,
  title,
}: LandingItemTextProps) => (
  <span className="flex min-w-0 items-start gap-2">
    {icon !== undefined && (
      <LandingRowIcon tone={iconTone}>{icon}</LandingRowIcon>
    )}
    <span className="min-w-0 flex-1">
      <BidiText
        as="span"
        className="text-foreground block truncate text-sm font-medium"
      >
        {title}
      </BidiText>
      {meta !== undefined && meta !== null ? (
        <span className="text-muted-foreground block truncate text-xs">
          {meta}
        </span>
      ) : null}
    </span>
  </span>
);

type LandingRowIconProps = {
  children: ReactElement;
  tone?: "muted" | "matter" | undefined;
};

const LandingRowIcon = ({ children, tone = "muted" }: LandingRowIconProps) => (
  <span
    className={cn(
      "mt-0.5 flex size-4 shrink-0 items-center justify-center transition-colors",
      tone === "muted" &&
        "text-foreground-muted group-hover:text-muted-foreground",
    )}
  >
    {children}
  </span>
);

const SlashPromptIcon = () => (
  <span className="font-mono text-[13px] leading-none">/</span>
);

type LandingEmptyProps = {
  children: ReactNode;
};

const LandingEmpty = ({ children }: LandingEmptyProps) => (
  <div className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-3 text-sm">
    {children}
  </div>
);
