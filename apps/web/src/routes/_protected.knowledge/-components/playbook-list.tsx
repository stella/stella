import { useQuery } from "@tanstack/react-query";
import {
  ClipboardCheckIcon,
  Clock3Icon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";

import { PlaybookStatusBadge } from "@/components/playbook-status-badge";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import type {
  PlaybookListItem,
  RecentPlaybookItem,
} from "@/lib/knowledge/playbook-types";
import { recentPlaybooksOptions } from "@/lib/knowledge/queries";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { PlaybookStarterCards } from "@/routes/_protected.knowledge/-components/playbook-starter-cards";

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

const RECENT_SKELETON_KEYS = ["recent-a", "recent-b", "recent-c"];

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
  const { data: recentData, isLoading: recentLoading } = useQuery({
    ...recentPlaybooksOptions(organizationId),
    refetchOnWindowFocus: false,
  });
  const recentPlaybooks = recentData ? recentData.items : [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-9 px-5 py-7 sm:px-7 sm:py-9">
        <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("common.playbooks")}
            </h1>
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
              {t("knowledge.playbooks.homeDescription")}
            </p>
          </div>
          {canCreate && (
            <Button className="h-11 shrink-0" onClick={onNewPlaybook}>
              <PlusIcon />
              {t("knowledge.playbooks.createPlaybook")}
            </Button>
          )}
        </header>

        {canCreate && (
          <section aria-labelledby="recommended-playbooks-heading">
            <SectionHeading
              id="recommended-playbooks-heading"
              title={t("knowledge.playbooks.recommended")}
            />
            <PlaybookStarterCards
              onCreated={onSelect}
              organizationId={organizationId}
            />
          </section>
        )}

        {(recentLoading || recentPlaybooks.length > 0) && (
          <section aria-labelledby="recent-playbooks-heading">
            <SectionHeading
              id="recent-playbooks-heading"
              title={t("knowledge.playbooks.recent")}
            />
            {recentLoading ? (
              <div className="divide-y rounded-xl border">
                {RECENT_SKELETON_KEYS.map((key) => (
                  <div
                    className="flex min-h-16 items-center gap-3 px-4"
                    key={key}
                  >
                    <Skeleton className="size-9 rounded-lg" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-48" />
                      <Skeleton className="h-3 w-28" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <ul className="divide-y rounded-xl border">
                {recentPlaybooks.map((playbook) => (
                  <RecentPlaybookRow
                    key={playbook.id}
                    onSelect={() => onSelect(playbook.id)}
                    playbook={playbook}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        <section aria-labelledby="all-playbooks-heading">
          <div className="mb-3 flex min-h-11 items-center justify-between gap-3">
            <h2 className="text-base font-semibold" id="all-playbooks-heading">
              {t("knowledge.playbooks.all")}
            </h2>
            <Button
              aria-label={t("common.refresh")}
              className="size-11"
              onClick={onRefresh}
              size="icon"
              title={t("common.refresh")}
              variant="ghost"
            >
              <RotateCcwIcon />
            </Button>
          </div>

          {playbooks.length === 0 && !loading ? (
            <div className="rounded-xl border border-dashed px-5 py-8">
              <p className="text-sm font-medium">
                {t("knowledge.playbooks.empty")}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                {t("knowledge.playbooks.emptyDescription")}
              </p>
            </div>
          ) : (
            <ul className="divide-y rounded-xl border">
              {playbooks.map((playbook) => (
                <PlaybookRow
                  key={playbook.id}
                  onSelect={() => onSelect(playbook.id)}
                  playbook={playbook}
                />
              ))}
            </ul>
          )}

          {nextCursor && (
            <div className="flex justify-center pt-3">
              <Button
                className="min-h-11"
                disabled={loading}
                onClick={onLoadMore}
                variant="ghost"
              >
                {t("common.loadMore")}
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

type SectionHeadingProps = {
  id: string;
  title: string;
};

const SectionHeading = ({ id, title }: SectionHeadingProps) => (
  <div className="mb-3">
    <h2 className="text-base font-semibold" id={id}>
      {title}
    </h2>
  </div>
);

const RecentPlaybookRow = ({
  playbook,
  onSelect,
}: {
  playbook: RecentPlaybookItem;
  onSelect: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <li>
      <button
        className="hover:bg-muted/50 flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start"
        onClick={onSelect}
        type="button"
      >
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
          <Clock3Icon className="text-muted-foreground size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" dir="auto">
            {playbook.name}
          </p>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {t("knowledge.playbooks.lastUsed", {
              date: format.dateTime(
                new Date(playbook.lastUsedAt),
                MEDIUM_DATE_SHORT_TIME_FORMAT,
              ),
            })}
          </p>
        </div>
        <PlaybookStatusBadge status={playbook.status} />
      </button>
    </li>
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
        className="hover:bg-muted/50 flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start"
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
          <p
            className="text-muted-foreground mt-0.5 truncate text-xs"
            dir="auto"
          >
            {playbook.description ??
              t("knowledge.playbooks.updatedAt", {
                date: format.dateTime(new Date(playbook.updatedAt), {
                  dateStyle: "medium",
                }),
              })}
          </p>
        </div>
        <PlaybookStatusBadge status={playbook.status} />
        <span className="sr-only">{t("common.edit")}</span>
      </button>
    </li>
  );
};
