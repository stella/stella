import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  ArrowRightIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  Clock3Icon,
  RotateCcwIcon,
  SparklesIcon,
} from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { Skeleton } from "@stll/ui/skeleton";
import { TruncatedText } from "@stll/ui/truncated-text";

import { PlaybookStatusBadge } from "@/components/playbook-status-badge";
import type {
  KnowledgeActions,
  KnowledgeSource,
} from "@/features/knowledge/views/knowledge-seam";
import {
  PlaybooksLibraryHeading,
  PlaybooksPageFrame,
  PlaybooksPageHeader,
  PlaybooksSectionHeading,
  PlaybookStarterCardsPending,
} from "@/features/knowledge/views/playbooks/playbooks-page-shape";
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
      <PlaybooksPageFrame>
        <PlaybooksPageHeader
          description={t("knowledge.playbooks.homeDescription")}
          title={t("common.playbooks")}
          toolbar={toolbar}
        />

        {actions.startFrom && (
          <section aria-labelledby="recommended-playbooks-heading">
            <SectionHeading
              id="recommended-playbooks-heading"
              title={t("knowledge.playbooks.recommended")}
            />
            <PlaybookStarterCards
              builder={actions.buildWithAi}
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
            <PlaybooksLibraryHeading
              id="all-playbooks-heading"
              refresh={
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
              }
            >
              {t("knowledge.playbooks.all")}
            </PlaybooksLibraryHeading>

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
      </PlaybooksPageFrame>
    </div>
  );
};

type SectionHeadingProps = {
  id: string;
  title: string;
};

const SectionHeading = ({ id, title }: SectionHeadingProps) => (
  <PlaybooksSectionHeading id={id}>{title}</PlaybooksSectionHeading>
);

// The card is drawn by the content of a plain Button: it lights while the
// button is pointed at and fades while the button is disabled.
const STARTER_CARD_CLASS =
  "border-border bg-card group-hover/plain:border-foreground/25 group-hover/plain:bg-muted/30 group-disabled/plain:opacity-60 flex h-full min-h-44 w-full flex-col rounded-xl border p-4";

const PLAYBOOK_ROW_CLASS =
  "group-hover/plain:bg-muted/50 flex min-h-16 w-full items-center gap-3 px-4 py-3";

type StarterCardActionProps = {
  isPending: boolean;
  label: string;
};

const StarterCardAction = ({ isPending, label }: StarterCardActionProps) => {
  const t = useTranslations();
  return (
    <span className="text-foreground mt-auto flex items-center gap-1 pt-4 text-sm font-medium">
      {isPending ? (
        <Loader className="size-4" label={t("common.loading")} size="sm" />
      ) : (
        <>
          {label}
          <ArrowRightIcon className="size-4 rtl:rotate-180" />
        </>
      )}
    </span>
  );
};

type BuildWithAiCardProps = {
  onStart: () => void;
  disabled: boolean;
};

const BuildWithAiCard = ({ onStart, disabled }: BuildWithAiCardProps) => {
  const t = useTranslations();
  return (
    <li>
      <Button
        className="group/plain flex h-full min-h-44 w-full"
        disabled={disabled}
        onClick={onStart}
        variant="plain"
      >
        <div className={STARTER_CARD_CLASS}>
          <span className="bg-muted flex size-10 items-center justify-center rounded-lg">
            <SparklesIcon className="text-muted-foreground size-5" />
          </span>
          <span className="mt-3 font-medium">
            {t("knowledge.playbooks.buildWithAi.title")}
          </span>
          <TruncatedText
            className="text-muted-foreground mt-1 text-sm"
            lines={2}
          >
            {t("knowledge.playbooks.buildWithAi.description")}
          </TruncatedText>
          <StarterCardAction isPending={false} label={t("common.start")} />
        </div>
      </Button>
    </li>
  );
};

type PlaybookStarterCardsProps = {
  starters: PlaybooksSource["starters"];
  onStart: (starter: KnowledgePlaybookStarter) => void;
  builder: (() => void) | undefined;
};

const PlaybookStarterCards = ({
  starters,
  onStart,
  builder,
}: PlaybookStarterCardsProps) => {
  const t = useTranslations();

  if (starters.status === "loading") {
    return <PlaybookStarterCardsPending />;
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

  const anyPending = starters.pendingStarterId !== null;
  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {builder && <BuildWithAiCard disabled={anyPending} onStart={builder} />}
      {starters.items.map((starter) => {
        const isPending = starters.pendingStarterId === starter.starterId;
        return (
          <li key={starter.starterId}>
            <Button
              className="group/plain flex h-full min-h-44 w-full"
              disabled={anyPending}
              onClick={() => onStart(starter)}
              variant="plain"
            >
              <div className={STARTER_CARD_CLASS}>
                <span className="bg-muted flex size-10 items-center justify-center rounded-lg">
                  <ClipboardListIcon className="text-muted-foreground size-5" />
                </span>
                <span className="mt-3 font-medium" dir="auto">
                  {starter.name}
                </span>
                <TruncatedText
                  className="text-muted-foreground mt-1 text-sm"
                  dir="auto"
                  lines={2}
                >
                  {starter.description}
                </TruncatedText>
                <span className="text-muted-foreground mt-2 text-xs">
                  {t("knowledge.playbooks.starters.positionCount", {
                    count: starter.positionCount,
                  })}
                </span>
                <StarterCardAction
                  isPending={isPending}
                  label={t("knowledge.playbooks.starters.useStarter")}
                />
              </div>
            </Button>
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
      <Button
        className="group/plain flex w-full"
        onClick={onSelect}
        variant="plain"
      >
        <div className={PLAYBOOK_ROW_CLASS}>
          <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
            <Clock3Icon className="text-muted-foreground size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <TruncatedText
              className="text-sm font-medium"
              dir="auto"
              render={<p />}
            >
              {playbook.name}
            </TruncatedText>
            <TruncatedText
              className="text-muted-foreground mt-0.5 text-xs"
              render={<p />}
            >
              {t("knowledge.playbooks.lastUsed", {
                date: format.dateTime(
                  new Date(playbook.lastUsedAt),
                  MEDIUM_DATE_SHORT_TIME_FORMAT,
                ),
              })}
            </TruncatedText>
          </div>
          <PlaybookStatusBadge status={playbook.status} />
        </div>
      </Button>
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
      <Button
        className="group/plain flex w-full"
        onClick={onSelect}
        variant="plain"
      >
        <div className={PLAYBOOK_ROW_CLASS}>
          <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
            <ClipboardCheckIcon className="text-muted-foreground size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <TruncatedText
              className="text-sm font-medium"
              dir="auto"
              render={<p />}
            >
              {playbook.name}
            </TruncatedText>
            <TruncatedText
              className="text-muted-foreground mt-0.5 text-xs"
              dir="auto"
              render={<p />}
            >
              <PlaybookRowDetail playbook={playbook} />
            </TruncatedText>
          </div>
          <PlaybookStatusBadge status={playbook.status} />
          <span className="sr-only">{t("common.edit")}</span>
        </div>
      </Button>
    </li>
  );
};
