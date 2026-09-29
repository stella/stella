import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { PlusIcon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import {
  memberKnowledgeActions,
  memberKnowledgeSource,
} from "@/features/knowledge/member/member-knowledge";
import { PlaybooksPageView } from "@/features/knowledge/views/playbooks/playbooks-page-view";
import { usePermissions } from "@/hooks/use-permissions";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import type { PlaybookListItem } from "@/lib/knowledge/playbook-types";

type PlaybookListProps = {
  playbooks: PlaybookListItem[];
  nextCursor: string | null;
  loading: boolean;
  organizationId: string;
  onNewPlaybook: () => void;
  onSelect: (playbookId: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
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
}: PlaybookListProps) => {
  const t = useTranslations();
  const canCreate = usePermissions({ playbook: ["create"] });
  const recent = memberKnowledgeSource.useRecentPlaybooks(organizationId);
  const starters = memberKnowledgeSource.usePlaybookStarters(
    organizationId,
    canCreate,
  );
  const playbookActions =
    memberKnowledgeActions.usePlaybookActions(organizationId);

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
      stellaToast.add({
        title: t("common.unexpectedError"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
        type: "error",
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

  return (
    <PlaybooksPageView
      actions={{
        startFrom: canCreate
          ? (starter) => startFrom(starter.starterId)
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
  );
};
