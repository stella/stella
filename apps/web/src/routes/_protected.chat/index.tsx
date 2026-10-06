import { useMemo } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  HistoryIcon,
  NewChatIcon,
  PinIcon,
  PlusIcon,
  SkillIcon,
} from "@stll/ui/icons";
import {
  LANDING_ROW_CLASS,
  LANDING_SECTION_HEADING_CLASS,
  LandingEmpty,
  LandingGreeting,
  LandingItemText,
  LandingLayout,
  LandingSection,
} from "@stll/ui/landing";
import { cn } from "@stll/ui/utils";

import { ChatThreadOriginPrefix } from "@/components/chat/chat-thread-origin-prefix";
import { MatterIcon } from "@/components/matter-icon";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { UserIdentityAvatar } from "@/components/user-avatar";
import { MatterContextMenu } from "@/components/workspaces/matter-context-menu";
import {
  groupedChatThreadsOptions,
  listChatHistoryItems,
  mergeGroupedChatThreadPages,
} from "@/features/chat/queries";
import { TeamAvatars } from "@/features/workspaces/team-avatars";
import { usePermissions } from "@/hooks/use-permissions";
import { getAnalytics } from "@/lib/analytics/provider";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { detached } from "@/lib/detached";
import { getDisplayName } from "@/lib/get-display-name";
import { skillsOptions } from "@/lib/knowledge/queries";
import { resolveMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { useSuggestedSkills } from "@/lib/prompts/use-suggested-skills";
import type { SuggestedSkill } from "@/lib/prompts/use-suggested-skills";
import {
  prefetchNonCriticalInfiniteQuery,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { formatRelativeTime } from "@/lib/relative-time";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import type { WorkspaceMemberPreview } from "@/lib/workspaces/queries/workspace-member-previews";
import { workspaceMemberPreviewsOptions } from "@/lib/workspaces/queries/workspace-member-previews";
import { ChatFileStack } from "@/routes/_protected.chat/-components/chat-file-stack";
import { useChatFullSurface } from "@/routes/_protected.chat/-components/chat-full-surface-context";
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
          groupedChatThreadsOptions({
            activeOrganizationId,
            userId: context.user.id,
          }),
          onPrefetchError,
        ),
        prefetchNonCriticalInfiniteQuery(
          context.queryClient,
          skillsOptions(activeOrganizationId, context.user.id),
          onPrefetchError,
        ),
      ]),
      "chat-index.prefetch",
    );
  },
  component: ChatIndex,
});

const protectedRouteApi = getRouteApi("/_protected");

/** Who else works on a matter, as a compact avatar stack on its row. */
const MatterColleagues = ({
  currentUserId,
  preview,
}: {
  currentUserId: string;
  preview: WorkspaceMemberPreview | undefined;
}) => {
  if (!preview) {
    return null;
  }
  const colleagues = preview.members.flatMap(
    ({ email, userId, image, name }) =>
      userId === currentUserId
        ? []
        : [
            {
              userEmail: email,
              userId,
              userImage: image,
              userName: name,
            },
          ],
  );
  const viewerCount = preview.members.some(
    (member) => member.userId === currentUserId,
  )
    ? 1
    : 0;
  return (
    <TeamAvatars
      emptyFallback={null}
      leadUserId={null}
      members={colleagues}
      totalCount={preview.total - viewerCount}
      size="size-6"
    />
  );
};

function ChatIndex() {
  const t = useTranslations();
  const { selectPrompt, focusComposer } = useChatFullSurface();
  const suggestedSkills = useSuggestedSkills();
  const pinnedOrder = usePinnedStore((state) => state.pinnedOrder);
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const openCreateMatter = useCreateMatterStore((state) => state.openDialog);
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (context) => context.user.activeOrganizationId,
  });
  const userId = protectedRouteApi.useRouteContext({
    select: (context) => context.user.id,
  });
  const { data: workspacesData } = useQuery(
    workspacesNavigationOptions(activeOrganizationId),
  );
  const workspaces = workspacesData?.workspaces;
  const { data: groupedThreadPages } = useInfiniteQuery(
    groupedChatThreadsOptions({ activeOrganizationId, userId }),
  );
  const groupedThreads = useMemo(
    () => mergeGroupedChatThreadPages(groupedThreadPages?.pages),
    [groupedThreadPages?.pages],
  );

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
  const { data: memberPreviews } = useQuery(
    workspaceMemberPreviewsOptions({
      organizationId: activeOrganizationId,
      userId,
      workspaceIds: visibleMatters.map((matter) => matter.id),
    }),
  );
  const mattersHeading =
    pinnedMatters.length > 0
      ? t("chat.landing.pinnedMatters")
      : t("chat.landing.lastAccessedMatters");

  const recentChats = useMemo(
    () => listChatHistoryItems(groupedThreads).slice(0, 5),
    [groupedThreads],
  );
  const storedMatterColor = (workspaceId: string) =>
    workspaces?.find(({ id }) => id === workspaceId)?.color ?? null;

  return (
    <LandingLayout
      hero={
        <LandingGreeting icon={<StellaMark className="size-7" />}>
          {t("chat.greeting")}
        </LandingGreeting>
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
                className={cn(LANDING_ROW_CLASS, "flex items-center gap-3")}
                params={{ workspaceId: matter.id }}
                to="/workspaces/$workspaceId"
              >
                <span className="min-w-0 flex-1">
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
                </span>
                <MatterColleagues
                  currentUserId={userId}
                  preview={memberPreviews?.previews.find(
                    (preview) => preview.workspaceId === matter.id,
                  )}
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
            search={{ kind: "skill" }}
            to="/knowledge/tools"
          >
            <SkillIcon className="size-4" />
            {t("chat.landing.skills")}
          </Link>
        }
      >
        {suggestedSkills.length > 0 ? (
          suggestedSkills.map((skill) => (
            <SuggestedSkillRow
              key={skill.id}
              onSelect={() => selectPrompt(skill)}
              skill={skill}
            />
          ))
        ) : (
          <LandingEmpty>{t("chat.landing.noSkills")}</LandingEmpty>
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
                className={cn(LANDING_ROW_CLASS, "flex items-center gap-3")}
                key={chat.id}
                params={{
                  workspaceId: chat.workspaceId,
                  threadId: chat.id,
                }}
                to="/chat/workspaces/$workspaceId/$threadId"
              >
                <span className="min-w-0 flex-1">
                  <LandingItemText
                    meta={
                      <>
                        <ChatThreadOriginPrefix origin={chat.origin} />
                        <span
                          aria-hidden="true"
                          // Centred on the cap height, not the x-height:
                          // `align-middle` reads low beside capitals.
                          className="me-1.5 inline-block size-1.5 rounded-full align-[0.1em]"
                          style={{
                            backgroundColor: resolveMatterColor(
                              chat.workspaceId,
                              storedMatterColor(chat.workspaceId),
                            ),
                          }}
                        />
                        <BidiText>{chat.workspaceName}</BidiText>
                        {" · "}
                        {formatRelativeTime(chat.updatedAt)}
                      </>
                    }
                    title={
                      isPlaceholderThreadTitle(chat.title)
                        ? t("chat.newChat")
                        : chat.title
                    }
                  />
                </span>
                <ChatFileStack attachedFiles={chat.context} />
              </Link>
            ) : (
              <Link
                className={cn(LANDING_ROW_CLASS, "flex items-center gap-3")}
                key={chat.id}
                params={{ threadId: chat.id }}
                to="/chat/$threadId"
              >
                <span className="min-w-0 flex-1">
                  <LandingItemText
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
                </span>
                <ChatFileStack attachedFiles={chat.context} />
              </Link>
            ),
          )
        ) : (
          <LandingEmpty>
            <div className="flex flex-col items-start gap-2.5">
              {t("chat.landing.noRecentChats")}
              <Button onClick={focusComposer} size="sm" variant="outline">
                <NewChatIcon className="size-4" />
                {t("chat.newChat")}
              </Button>
            </div>
          </LandingEmpty>
        )}
      </LandingSection>
    </LandingLayout>
  );
}

type SuggestedSkillRowProps = {
  onSelect: () => void;
  skill: SuggestedSkill;
};

/**
 * A suggested skill, signed on the right by its author: the member who last
 * edited it, or stella for a built-in or unedited bundled skill. An author
 * the data cannot name (a former member, a system write) shows nothing.
 */
const SuggestedSkillRow = ({ onSelect, skill }: SuggestedSkillRowProps) => (
  <button
    className={cn(LANDING_ROW_CLASS, "flex items-center gap-3")}
    onClick={onSelect}
    type="button"
  >
    <span className="min-w-0 flex-1">
      <LandingItemText meta={skill.body} title={skill.name} />
    </span>
    <SkillAuthorAvatar author={skillAuthor(skill)} />
  </button>
);

type SkillAuthor =
  | {
      type: "member";
      edit: Extract<SuggestedSkill["lastEdit"], { type: "user" }>;
    }
  | { type: "stella" }
  | { type: "unknown" };

const skillAuthor = ({ lastEdit }: SuggestedSkill): SkillAuthor => {
  if (lastEdit === null) {
    return { type: "unknown" };
  }
  switch (lastEdit.type) {
    case "user":
      return { type: "member", edit: lastEdit };
    case "stella":
      return { type: "stella" };
    case "unattributed":
      return { type: "unknown" };
    default: {
      lastEdit satisfies never;
      return panic(`Unhandled skill last edit: ${String(lastEdit)}`);
    }
  }
};

const AVATAR_RING_CLASS =
  "ring-background inline-flex shrink-0 rounded-full ring-2";

const SkillAuthorAvatar = ({ author }: { author: SkillAuthor }) => {
  const t = useTranslations();
  switch (author.type) {
    case "member": {
      const name =
        getDisplayName(author.edit.user.name) ?? t("common.unknownUser");
      return (
        <Tooltip
          content={t("chat.landing.skillEditedBy", {
            name,
            time: formatRelativeTime(author.edit.at),
          })}
          render={<span className={AVATAR_RING_CLASS} />}
        >
          <UserIdentityAvatar
            className="size-6"
            image={author.edit.user.image}
            name={name}
          />
        </Tooltip>
      );
    }
    case "stella":
      return (
        <Tooltip
          content={t("catalogue.firstParty")}
          render={<span className={AVATAR_RING_CLASS} />}
        >
          <span className="bg-muted text-foreground flex size-6 items-center justify-center rounded-full">
            <StellaMark className="size-3.5" />
          </span>
        </Tooltip>
      );
    case "unknown":
      return null;
    default: {
      author satisfies never;
      return panic(`Unhandled skill author: ${String(author)}`);
    }
  }
};

type PinnedMatter = {
  color: string | null;
  id: string;
  lastActivityAt: Date;
  name: string;
  /** Drives the right-click menu's add-member affordance and header. */
  client: { displayName: string } | null;
};
