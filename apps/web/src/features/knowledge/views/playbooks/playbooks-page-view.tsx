import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  ArrowRightIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  Clock3Icon,
  RotateCcwIcon,
} from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { Skeleton } from "@stll/ui/skeleton";

import { PlaybookStatusBadge } from "@/components/playbook-status-badge";
import type {
  KnowledgeActions,
  KnowledgeSource,
} from "@/features/knowledge/views/knowledge-seam";
import type {
  KnowledgePlaybook,
  KnowledgePlaybookStarter,
  KnowledgeRecentPlaybook,
  PlaybooksSource,
} from "@/features/knowledge/views/playbooks/playbooks-seam";
import { useFormatter } from "@/i18n/formatting-context";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

type PlaybooksPageViewProps = {
  source: KnowledgeSource<"playbooks">;
  actions: KnowledgeActions<"playbooks">;
  /** Controls at the end of the page header. */
  toolbar?: ReactNode;
  /** A note after the ready-made playbooks. */
  teaser?: ReactNode;
};

const RECENT_SKELETON_KEYS = ["recent-a", "recent-b", "recent-c"];
const STARTER_SKELETON_KEYS = ["nda", "dpa", "msa", "saas"];

export const PlaybooksPageView = ({
  source,
  actions,
  toolbar,
  teaser,
}: PlaybooksPageViewProps) => {
  const t = useTranslations();
  const { recent, library } = source;

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
          {toolbar}
        </header>

        {actions.startFrom && (
          <section aria-labelledby="recommended-playbooks-heading">
            <SectionHeading
              id="recommended-playbooks-heading"
              title={t("knowledge.playbooks.recommended")}
            />
            <PlaybookStarterCards
              onStart={actions.startFrom}
              starters={source.starters}
            />
          </section>
        )}

        {teaser}

        {recent && (recent.status === "loading" || recent.items.length > 0) && (
          <section aria-labelledby="recent-playbooks-heading">
            <SectionHeading
              id="recent-playbooks-heading"
              title={t("knowledge.playbooks.recent")}
            />
            {recent.status === "loading" ? (
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
                {recent.items.map((playbook) => (
                  <RecentPlaybookRow
                    key={playbook.id}
                    onSelect={() => actions.open(playbook.id)}
                    playbook={playbook}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        {library && (
          <section aria-labelledby="all-playbooks-heading">
            <div className="mb-3 flex min-h-11 items-center justify-between gap-3">
              <h2
                className="text-base font-semibold"
                id="all-playbooks-heading"
              >
                {t("knowledge.playbooks.all")}
              </h2>
              <Button
                aria-label={t("common.refresh")}
                className="size-11"
                onClick={actions.refresh}
                size="icon"
                title={t("common.refresh")}
                variant="ghost"
              >
                <RotateCcwIcon />
              </Button>
            </div>

            {library.playbooks.length === 0 && !library.isFetchingNextPage ? (
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
                {library.playbooks.map((playbook) => (
                  <PlaybookRow
                    key={playbook.id}
                    onSelect={() => actions.open(playbook.id)}
                    playbook={playbook}
                  />
                ))}
              </ul>
            )}

            {library.hasNextPage && (
              <div className="flex justify-center pt-3">
                <Button
                  className="min-h-11"
                  disabled={library.isFetchingNextPage}
                  onClick={actions.loadMore}
                  variant="ghost"
                >
                  {t("common.loadMore")}
                </Button>
              </div>
            )}
          </section>
        )}
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

type PlaybookStarterCardsProps = {
  starters: PlaybooksSource["starters"];
  onStart: (starter: KnowledgePlaybookStarter) => void;
};

const PlaybookStarterCards = ({
  starters,
  onStart,
}: PlaybookStarterCardsProps) => {
  const t = useTranslations();

  if (starters.status === "loading") {
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {STARTER_SKELETON_KEYS.map((key) => (
          <Skeleton className="h-44 rounded-xl" key={key} />
        ))}
      </div>
    );
  }

  if (starters.status === "error") {
    const { retry } = starters;
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground text-sm">
          {t("knowledge.catalogue.unavailable")}
        </p>
        {retry && (
          <Button onClick={retry} size="sm" type="button" variant="outline">
            {t("common.retry")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {starters.items.map((starter) => {
        const isPending = starters.pendingStarterId === starter.starterId;
        return (
          <li key={starter.starterId}>
            <button
              className="border-border bg-card hover:border-foreground/25 hover:bg-muted/30 focus-visible:ring-ring flex h-full min-h-44 w-full flex-col rounded-xl border p-4 text-start focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
              disabled={starters.pendingStarterId !== null}
              onClick={() => onStart(starter)}
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
                  <Loader
                    className="size-4"
                    label={t("common.loading")}
                    size="sm"
                  />
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

const RecentPlaybookRow = ({
  playbook,
  onSelect,
}: {
  playbook: KnowledgeRecentPlaybook;
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

/** The description, or when there is none, the last edit the source knows. */
const PlaybookRowDetail = ({ playbook }: { playbook: KnowledgePlaybook }) => {
  const t = useTranslations();
  const format = useFormatter();

  if (playbook.description !== null) {
    return playbook.description;
  }
  if (playbook.updatedAt === undefined) {
    return null;
  }
  return t("knowledge.playbooks.updatedAt", {
    date: format.dateTime(new Date(playbook.updatedAt), {
      dateStyle: "medium",
    }),
  });
};

const PlaybookRow = ({
  playbook,
  onSelect,
}: {
  playbook: KnowledgePlaybook;
  onSelect: () => void;
}) => {
  const t = useTranslations();

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
            <PlaybookRowDetail playbook={playbook} />
          </p>
        </div>
        <PlaybookStatusBadge status={playbook.status} />
        <span className="sr-only">{t("common.edit")}</span>
      </button>
    </li>
  );
};

const PLAYBOOK_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors the playbooks page (header, ready-made cards, list rows) so the page
// keeps its shape while the playbooks load.
export const PlaybooksPageSkeleton = () => (
  <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-9 px-5 py-7 sm:px-7 sm:py-9">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-11 w-36 rounded-md" />
      </div>
      <div>
        <Skeleton className="mb-3 h-5 w-44" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {["starter-a", "starter-b", "starter-c", "starter-d"].map((key) => (
            <Skeleton className="h-44 rounded-xl" key={key} />
          ))}
        </div>
      </div>
      <div>
        <Skeleton className="mb-3 h-5 w-28" />
        <ul className="divide-y rounded-xl border">
          {PLAYBOOK_ROW_KEYS.map((key) => (
            <li className="flex min-h-16 items-center gap-3 px-4" key={key}>
              <Skeleton className="size-9 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  </div>
);
