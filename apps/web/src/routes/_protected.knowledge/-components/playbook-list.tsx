import { ClipboardCheckIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { usePermissions } from "@/hooks/use-permissions";
import type { PlaybookListItem } from "@/routes/_protected.knowledge/-components/playbook-types";

type PlaybookListProps = {
  playbooks: PlaybookListItem[];
  nextCursor: string | null;
  loading: boolean;
  onNewPlaybook: () => void;
  onSelect: (playbook: PlaybookListItem) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
};

export const PlaybookList = ({
  playbooks,
  nextCursor,
  loading,
  onNewPlaybook,
  onSelect,
  onLoadMore,
  onRefresh,
}: PlaybookListProps) => {
  const t = useTranslations();
  const canCreate = usePermissions({ playbook: ["create"] });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end gap-1 border-b px-4 py-2">
        <Button
          aria-label={t("common.refresh")}
          onClick={onRefresh}
          size="icon-sm"
          title={t("common.refresh")}
          variant="ghost"
        >
          <RotateCcwIcon />
        </Button>
        {canCreate && (
          <Button
            aria-label={t("knowledge.playbooks.createPlaybook")}
            onClick={onNewPlaybook}
            size="sm"
            title={t("knowledge.playbooks.createPlaybook")}
          >
            <PlusIcon />
            <span className="hidden sm:inline">
              {t("knowledge.playbooks.createPlaybook")}
            </span>
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {playbooks.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center gap-1 p-8">
            <p className="text-sm font-medium">
              {t("knowledge.playbooks.empty")}
            </p>
            <p className="text-muted-foreground text-sm">
              {t("knowledge.playbooks.emptyDescription")}
            </p>
          </div>
        )}

        <ul className="divide-y">
          {playbooks.map((playbook) => (
            <PlaybookRow
              key={playbook.id}
              onSelect={() => onSelect(playbook)}
              playbook={playbook}
            />
          ))}
        </ul>

        {nextCursor && (
          <div className="flex justify-center border-t p-3">
            <Button
              disabled={loading}
              onClick={onLoadMore}
              size="sm"
              variant="ghost"
            >
              {t("common.loadMore")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

const PlaybookRow = ({
  playbook,
  onSelect,
}: {
  playbook: PlaybookListItem;
  onSelect: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <li>
      <button
        className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-start"
        onClick={onSelect}
        type="button"
      >
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
          <ClipboardCheckIcon className="text-muted-foreground size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" dir="auto">
            {playbook.name}
          </p>
          <p className="text-muted-foreground truncate text-xs" dir="auto">
            {playbook.description ??
              format.dateTime(new Date(playbook.createdAt), {
                dateStyle: "medium",
              })}
          </p>
        </div>
        <span className="sr-only">{t("common.edit")}</span>
      </button>
    </li>
  );
};
