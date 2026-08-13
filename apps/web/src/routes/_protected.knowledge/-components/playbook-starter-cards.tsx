import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, ClipboardListIcon, LoaderIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  knowledgeKeys,
  playbookStartersOptions,
} from "@/lib/knowledge/queries";

type StarterId = Parameters<
  (typeof api.playbooks)["from-starter"]["post"]
>[0]["starterId"];

type PlaybookStarterCardsProps = {
  onCreated: (playbookId: string) => void;
  organizationId: string;
};

const STARTER_SKELETON_KEYS = ["nda", "dpa", "msa", "saas"];

export const PlaybookStarterCards = ({
  onCreated,
  organizationId,
}: PlaybookStarterCardsProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(playbookStartersOptions(organizationId));
  const starters = data ? data.items : [];

  const create = useMutation({
    mutationFn: async (starterId: StarterId) => {
      const response = await api.playbooks["from-starter"].post({ starterId });
      return unwrapEden(response);
    },
    onSuccess: ({ id, outcome }) => {
      detached(
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.playbooks.all(organizationId),
        }),
        "playbook-starter-cards.invalidate",
      );
      if (outcome === "created") {
        stellaToast.add({
          title: t("knowledge.playbooks.starters.addedToast"),
          type: "success",
        });
      }
      onCreated(id);
    },
    onError: (error) => {
      stellaToast.add({
        title: t("common.unexpectedError"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
        type: "error",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {STARTER_SKELETON_KEYS.map((key) => (
          <Skeleton className="h-44 rounded-xl" key={key} />
        ))}
      </div>
    );
  }

  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {starters.map((starter) => {
        const isPending =
          create.isPending && create.variables === starter.starterId;
        return (
          <li key={starter.starterId}>
            <button
              className="border-border bg-card hover:border-foreground/25 hover:bg-muted/30 focus-visible:ring-ring flex h-full min-h-44 w-full flex-col rounded-xl border p-4 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
              disabled={create.isPending}
              onClick={() => create.mutate(starter.starterId)}
              type="button"
            >
              <span className="bg-muted flex size-10 items-center justify-center rounded-lg">
                <ClipboardListIcon className="text-muted-foreground size-5" />
              </span>
              <span className="mt-3 font-medium" dir="auto">
                {starter.name}
              </span>
              <span
                className="text-muted-foreground mt-1 line-clamp-2 text-sm"
                dir="auto"
              >
                {starter.description}
              </span>
              <span className="text-muted-foreground mt-2 text-xs">
                {t("knowledge.playbooks.starters.positionCount", {
                  count: starter.positionCount,
                })}
              </span>
              <span className="text-foreground mt-auto flex items-center gap-1 pt-4 text-sm font-medium">
                {isPending ? (
                  <LoaderIcon className="size-4 animate-spin" />
                ) : (
                  <>
                    {t("knowledge.playbooks.starters.useStarter")}
                    <ArrowRightIcon className="size-4 rtl:rotate-180" />
                  </>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
};
