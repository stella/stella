import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
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
  LayersIcon,
  MessageSquareIcon,
  Minimize2Icon,
  PinIcon,
  PlusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { useAIKeyGate } from "@/components/require-ai-key";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { usePermissions } from "@/hooks/use-permissions";
import { useI18nStore } from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { api } from "@/lib/api";
import {
  getChatSendMode,
  useChatAnonymized,
  useSetChatAnonymized,
} from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { useChatWebSearchPreferenceStore } from "@/lib/chat-web-search-store";
import { toAPIError } from "@/lib/errors";
import { resolveMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { formatRelativeTime } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import { ChatAnonymizedToggle } from "@/routes/_protected.chat/-components/chat-anonymized-toggle";
import { ChatWebSearchToggle } from "@/routes/_protected.chat/-components/chat-web-search-toggle";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
  chatThreadOptions,
  groupedChatThreadsOptions,
  invalidateGroupedChatThreads,
  mergeGroupedChatThreadPages,
} from "@/routes/_protected.chat/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";

export const Route = createFileRoute("/_protected/chat/")({
  component: ChatIndex,
});

const protectedRouteApi = getRouteApi("/_protected");

function ChatIndex() {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const { ensureAIAvailable } = useAIKeyGate();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const threadIdRef = useRef(createChatThreadId());
  const threadRef: ChatThreadRef = {
    scope: "global",
    threadId: threadIdRef.current,
  };
  const controller = useChatEditor({ threadRef });
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
  const setAnonymized = useSetChatAnonymized(threadRef);
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
      threadIdRef.current,
      "draftMeta",
    ] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const response = await api.chat
        .threads({ threadId: toSafeId<"chatThread">(threadIdRef.current) })
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
  useEffect(() => {
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
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <ChatMatterPicker
          matterIds={contextMatterIds}
          onChange={setContextMatterIds}
        />
        <div className="flex items-center gap-1">
          {chatDraftMeta?.webSearchAvailable && (
            <ChatWebSearchToggle
              enabled={chatDraftMeta.webSearchEnabled}
              threadRef={threadRef}
            />
          )}
          <ChatAnonymizedToggle enabled={anonymized} onChange={setAnonymized} />
          <Tooltip
            content={t("chat.moveToSide")}
            render={
              <Button onClick={moveToSide} size="icon-sm" variant="ghost">
                <Minimize2Icon className="size-4" />
              </Button>
            }
          />
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pb-16">
        <div className="flex min-h-[22rem] w-full max-w-2xl shrink-0 flex-col items-center justify-center gap-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="border-border bg-background text-foreground flex size-12 items-center justify-center rounded-lg border shadow-sm">
              <StellaMark className="size-7" />
            </div>
            <p className="text-foreground max-w-md text-center text-lg font-medium">
              {t("chat.greetingSubtitle")}
            </p>
          </div>
          <div className="w-full">
            <ChatAnonymizationLayer
              editor={controller.editor}
              enabled={anonymized}
              workspaceId={threadRef.threadId}
            />
            <ChatInputSurface
              anonymized={anonymized}
              autoFocus
              controller={controller}
              onSubmit={async (draft) => {
                if (!(await ensureAIAvailable())) {
                  return;
                }
                // Build the request payload first, then resolve the
                // Chat<> instance from the cache; the thread route
                // reads the *same* cached instance, so kicking off
                // `sendMessage` here lets the thread page observe
                // the in-flight stream as soon as it mounts.
                const [message, { chat }] = await Promise.all([
                  buildChatRequestMessage(draft),
                  queryClient.ensureQueryData(
                    chatThreadOptions({
                      activeOrganizationId,
                      key: threadRef,
                      context: {
                        allowMissingThread: true,
                        getUserContext,
                        getContextMatterIds,
                        getSendMode,
                      },
                    }),
                  ),
                ]);

                // Fire-and-forget: don't block navigation on the
                // streaming response. The thread page picks up the
                // same Chat instance from cache and renders the
                // user message + streaming reply as it arrives.
                void chat.sendMessage(message);

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
                <PinIcon className="size-4" />
                {mattersHeading}
              </Link>
            }
          >
            {visibleMatters.length > 0 ? (
              visibleMatters.map((matter) => {
                const matterColor = resolveMatterColor(matter.id, matter.color);
                return (
                  <Link
                    className="group hover:bg-accent/50 focus-visible:ring-ring rounded-md px-2 py-1.5 text-start transition-colors outline-none focus-visible:ring-2"
                    key={matter.id}
                    params={{ workspaceId: matter.id }}
                    to="/workspaces/$workspaceId"
                  >
                    <LandingItemText
                      icon={
                        <LayersIcon
                          className="size-4"
                          style={{ color: matterColor }}
                        />
                      }
                      iconTone="matter"
                      meta={formatRelativeTime(matter.lastActivityAt, lang)}
                      title={matter.name}
                    />
                  </Link>
                );
              })
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
                      <PlusIcon />
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
                      meta={`${chat.workspaceName} - ${formatRelativeTime(chat.updatedAt, lang)}`}
                      title={chat.title}
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
                      meta={formatRelativeTime(chat.updatedAt, lang)}
                      title={chat.title}
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
  meta?: string | undefined;
  onClick: () => void;
  title: string;
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
        <span className="text-foreground block truncate text-sm font-medium">
          {title}
        </span>
        {meta && (
          <span className="text-muted-foreground block truncate text-xs">
            {meta}
          </span>
        )}
      </span>
    </span>
  </button>
);

type LandingItemTextProps = {
  icon?: ReactElement;
  iconTone?: "muted" | "matter" | undefined;
  meta?: string | undefined;
  title: string;
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
      <span className="text-foreground block truncate text-sm font-medium">
        {title}
      </span>
      {meta && (
        <span className="text-muted-foreground block truncate text-xs">
          {meta}
        </span>
      )}
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
