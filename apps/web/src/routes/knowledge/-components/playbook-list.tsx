import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { PlusIcon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import {
  PLAYBOOK_BUILDER_SKILL_NAME,
  setThreadActiveSkill,
} from "@/features/chat/thread-active-skill-store";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import {
  memberKnowledgeActions,
  memberKnowledgeSource,
} from "@/features/knowledge/member/member-knowledge";
import { PlaybooksPageView } from "@/features/knowledge/views/playbooks/playbooks-page-view";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { PlaybookListItem } from "@/lib/knowledge/playbook-types";
import { skillsOptions } from "@/lib/knowledge/queries";
import { organizationListOptions } from "@/lib/organization/queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

type PlaybookListProps = {
  playbooks: PlaybookListItem[];
  nextCursor: string | null;
  loading: boolean;
  organizationId: string;
  onNewPlaybook: () => void;
  onSelect: (playbookId: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  /** A ready-made playbook chosen before sign-in, still to be confirmed. */
  starterIntent?: string | undefined;
  /** Drops the chosen playbook from the page's query once it is settled. */
  onStarterIntentSettled?: (() => void) | undefined;
};

type PlaybookBuilderTitleOptions = {
  queryClient: QueryClient;
  organizationId: string;
  userId: string;
};

/**
 * The playbook builder's title as the skills list serves it, or `undefined`
 * when the list cannot be read: the chat then shows the skill's name.
 */
const readPlaybookBuilderTitle = async ({
  queryClient,
  organizationId,
  userId,
}: PlaybookBuilderTitleOptions): Promise<string | undefined> => {
  const skills = await Result.tryPromise({
    try: async () =>
      await queryClient.infiniteQuery({
        ...skillsOptions(organizationId, userId),
        staleTime: "static",
      }),
    catch: (error) => error,
  });
  if (Result.isError(skills)) {
    getAnalytics().captureError(skills.error);
    return undefined;
  }
  return skills.value.pages
    .at(0)
    ?.builtIn.find(({ slug }) => slug === PLAYBOOK_BUILDER_SKILL_NAME)?.name;
};

/** The organization's playbooks: the shared page with the member's starters,
 *  recent and full lists, and the create button in its toolbar. */
export const PlaybookList = ({
  playbooks,
  nextCursor,
  loading,
  organizationId,
  onNewPlaybook,
  onSelect,
  onLoadMore,
  onRefresh,
  starterIntent,
  onStarterIntentSettled,
}: PlaybookListProps) => {
  const t = useTranslations();
  const canCreate = usePermissions({ playbook: ["create"] });
  const { isPending: rolePending } = useQuery(roleOptions);
  const { id: userId } = useAuthenticatedUser();
  const organizationsQuery = useQuery(organizationListOptions(userId));
  const organizationsView = useQueryView(organizationsQuery);
  useQueryViewError(organizationsView);
  const organizations =
    organizationsView.type === "items" ? organizationsView.items : undefined;
  const organizationName =
    organizations?.find(({ id }) => id === organizationId)?.name ?? "";
  const recent = memberKnowledgeSource.useRecentPlaybooks(organizationId);
  const starters = memberKnowledgeSource.usePlaybookStarters(
    organizationId,
    canCreate,
  );
  const playbookActions =
    memberKnowledgeActions.usePlaybookActions(organizationId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Nothing is created here: the chat's first save creates the playbook.
  const buildWithAi = useMutation({
    mutationFn: async () => {
      const threadId = createChatThreadId();
      const skillDisplayName = await readPlaybookBuilderTitle({
        queryClient,
        organizationId,
        userId,
      });
      setThreadActiveSkill(
        { scope: "global", threadId },
        skillDisplayName === undefined
          ? { skillName: PLAYBOOK_BUILDER_SKILL_NAME }
          : { skillName: PLAYBOOK_BUILDER_SKILL_NAME, skillDisplayName },
      );
      await navigate({ to: "/chat/$threadId", params: { threadId } });
    },
    onError: (error) => {
      notifyUserError(error, t("common.unexpectedError"));
    },
  });

  const create = useMutation({
    mutationFn: playbookActions.createFromStarter,
    onSuccess: ({ id, outcome }) => {
      playbookActions.invalidatePlaybooks();
      if (outcome === "created") {
        stellaToast.add({
          title: t("knowledge.playbooks.starters.addedToast"),
          type: "success",
        });
      }
      onSelect(id);
    },
    onError: (error) => {
      notifyUserError(error, t("common.unexpectedError"), {
        description: userErrorFromThrown(error, t("common.unexpectedError")),
      });
    },
  });

  const startFrom = (starterId: string) => {
    // The card hands back the id it was given; start from the matching
    // ready-made playbook.
    const starter = starters.items.find(
      (candidate) => candidate.starterId === starterId,
    );
    if (starter) {
      create.mutate(starter.starterId);
    }
  };

  // A playbook chosen before sign-in is only a name: it is looked up in this
  // organization's own list of ready-made playbooks and confirmed there. One
  // the list lacks, or a member who may not create playbooks, drops it.
  const intentKnown =
    starterIntent !== undefined &&
    !rolePending &&
    (!canCreate || starters.status === "ready");
  const intendedStarter =
    intentKnown && canCreate
      ? starters.items.find(({ starterId }) => starterId === starterIntent)
      : undefined;
  const intentUnresolvable = intentKnown && intendedStarter === undefined;
  useExternalSyncEffect(() => {
    if (intentUnresolvable) {
      onStarterIntentSettled?.();
    }
  }, [intentUnresolvable, onStarterIntentSettled]);

  const starterConfirm = (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onStarterIntentSettled?.();
        }
      }}
      open={intendedStarter !== undefined}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t("knowledge.catalogue.confirmUseTitle", {
              name: intendedStarter?.name ?? "",
              organization: organizationName,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("knowledge.catalogue.confirmStarterDescription", {
              organization: organizationName,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            onClick={() => {
              const starter = intendedStarter;
              onStarterIntentSettled?.();
              if (starter !== undefined) {
                startFrom(starter.starterId);
              }
            }}
          >
            {t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  return (
    <>
      {starterIntent !== undefined && starterConfirm}
      <PlaybooksPageView
        actions={{
          startFrom: canCreate
            ? (starter) => startFrom(starter.starterId)
            : undefined,
          buildWithAi: canCreate
            ? {
                start: () => buildWithAi.mutate(),
                status: buildWithAi.isPending ? "starting" : "idle",
              }
            : undefined,
          open: onSelect,
          loadMore: onLoadMore,
          refresh: onRefresh,
        }}
        source={{
          starters: {
            ...starters,
            pendingStarterId: create.isPending ? create.variables : null,
          },
          recent,
          library: {
            playbooks,
            hasNextPage: Boolean(nextCursor),
            isFetchingNextPage: loading,
          },
        }}
        toolbar={
          canCreate && (
            <Button
              className="h-11 shrink-0"
              onClick={onNewPlaybook}
              {...guideAnchor(GUIDE_ANCHORS.playbooksCreate)}
            >
              <PlusIcon />
              {t("knowledge.playbooks.createPlaybook")}
            </Button>
          )
        }
      />
    </>
  );
};
