import { useEffectEvent, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  HistoryIcon,
  LayersIcon,
  MessageSquareIcon,
  Minimize2Icon,
  PinIcon,
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
import { useI18nStore } from "@/i18n/i18n-store";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import {
  getChatAnonymized,
  useChatAnonymized,
  useSetChatAnonymized,
} from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { resolveMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import type { ChatPrompt } from "@/lib/prompts/types";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { formatRelativeTime } from "@/lib/relative-time";
import { ChatAnonymizedToggle } from "@/routes/_protected.chat/-components/chat-anonymized-toggle";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
  chatThreadOptions,
  groupedChatThreadsOptions,
  invalidateGroupedChatThreads,
} from "@/routes/_protected.chat/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";

export const Route = createFileRoute("/_protected/chat/")({
  component: ChatIndex,
});

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
  const { data: workspacesData } = useQuery(workspacesNavigationOptions);
  const workspaces = workspacesData?.workspaces;
  const { data: groupedThreads } = useQuery(groupedChatThreadsOptions());
  const anonymized = useChatAnonymized(threadRef);
  const setAnonymized = useSetChatAnonymized(threadRef);
  const getAnonymized = useEffectEvent(() => getChatAnonymized(threadRef));
  const openInspectorChat = useInspectorStore((s) => s.openChat);
  const [contextMatterIds, setContextMatterIds] = useState<string[]>([]);
  const getContextMatterIds = useEffectEvent(() => contextMatterIds);

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
    for (const thread of groupedThreads?.global ?? []) {
      threads.push({
        scope: "global",
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
      });
    }
    for (const workspace of groupedThreads?.workspaces ?? []) {
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
    const editor = controller.editor;
    if (!editor) {
      return;
    }
    editor.commands.setContent(prompt.body);
    editor.commands.focus("end");
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
                const message = await buildChatRequestMessage(draft);
                const { chat } = await queryClient.ensureQueryData(
                  chatThreadOptions({
                    key: threadRef,
                    context: {
                      allowMissingThread: true,
                      getUserContext,
                      getContextMatterIds,
                      getAnonymized,
                    },
                  }),
                );

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
              <LandingEmpty>{t("chat.landing.noMatters")}</LandingEmpty>
            )}
          </LandingSection>
          <LandingSection
            heading={
              <Link
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-2 rounded-md px-1 text-xs font-semibold tracking-widest uppercase transition-colors outline-none focus-visible:ring-2"
                to="/knowledge/skills"
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
