/**
 * Review history: who did what to a claim, when, and why, with where the
 * claim stood just before and after each action. One claim's history folds
 * into a single row of the claim detail; a run's history opens in a sheet
 * beside the document, filterable by action and reviewer.
 */

import * as React from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowRightIcon, ChevronRightIcon, HistoryIcon } from "@stll/ui/icons";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { UserIdentity } from "@/components/user-avatar";
import { reviewHistoryOptions } from "@/features/avt/queries";
import type { ReviewHistoryFilter } from "@/features/avt/queries";
import {
  groupHistoryByOrigin,
  historyActionKey,
  historyChanges,
} from "@/features/avt/review-history.logic";
import type { HistoryChange } from "@/features/avt/review-history.logic";
import { STATE_COLOR } from "@/features/avt/state-chip";
import type {
  ClaimReviewEventKind,
  ReviewHistoryEntry,
  VerificationClaim,
} from "@/features/avt/types";
import {
  isReviewEventKind,
  REVIEW_EVENT_KIND_LABEL_KEYS,
  REVIEW_EVENT_KINDS,
  REVIEW_STATUS_META,
  STATE_META,
} from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

type RunScope = { workspaceId: string; runId: string };

type ClaimHistoryProps = RunScope & {
  claim: VerificationClaim;
};

/**
 * One claim's history, folded to a row with its count until opened. A claim
 * nobody has acted on says so on that row and has nothing to open.
 */
export const ClaimHistory = ({
  workspaceId,
  runId,
  claim,
}: ClaimHistoryProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = React.useState(false);
  const count = claim.review?.eventCount ?? 0;
  const panelId = React.useId();

  return (
    <section className="border-t pt-2">
      <Button
        aria-controls={panelId}
        aria-expanded={open}
        className="flex w-full items-center justify-between"
        disabled={count === 0}
        onClick={() => setOpen(!open)}
        variant="plain"
      >
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-bold tracking-wide uppercase">
          <DirectionalIcon
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
            flip={!open}
            icon={ChevronRightIcon}
          />
          {t("common.history")}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {count === 0 ? t("avt.history.none") : format.number(count)}
        </span>
      </Button>
      {open && (
        <div className="pt-1" id={panelId}>
          <HistoryEntries
            filter={{ claimId: claim.id }}
            runId={runId}
            workspaceId={workspaceId}
          />
        </div>
      )}
    </section>
  );
};

type RunHistorySheetProps = RunScope & {
  claims: readonly VerificationClaim[];
  onShowClaim: (claimId: VerificationClaim["id"]) => void;
};

const ALL = "all";

/** Every review action on a run, in a sheet with filters by action kind and
 *  reviewer; an entry opens the claim it was taken on. */
export const RunHistorySheet = ({
  workspaceId,
  runId,
  claims,
  onShowClaim,
}: RunHistorySheetProps) => {
  const t = useTranslations();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<ClaimReviewEventKind | null>(null);
  const [actorId, setActorId] = React.useState<string | null>(null);
  const claimText = new Map(claims.map((claim) => [claim.id, claim.text]));

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
        <HistoryIcon />
        {t("avt.history.runButton")}
      </Button>
      {open && (
        <SheetPopup side="inline-end">
          <SheetHeader>
            <SheetTitle>{t("avt.history.runTitle")}</SheetTitle>
          </SheetHeader>
          <SheetPanel>
            <div className="mb-3 flex flex-wrap gap-2">
              <Select
                onValueChange={(value) =>
                  setKind(
                    value !== null && isReviewEventKind(value) ? value : null,
                  )
                }
                value={kind ?? ALL}
              >
                <SelectTrigger
                  aria-label={t("avt.history.filters.kind")}
                  className="min-w-40 flex-1"
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL}>
                    {t("avt.history.filters.allKinds")}
                  </SelectItem>
                  {REVIEW_EVENT_KINDS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(REVIEW_EVENT_KIND_LABEL_KEYS[value])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <ReviewerFilter
                actorId={actorId}
                onChange={setActorId}
                runId={runId}
                workspaceId={workspaceId}
              />
            </div>
            <HistoryEntries
              claimText={claimText}
              filter={{
                ...(kind !== null && { kind }),
                ...(actorId !== null && { actorId }),
              }}
              onShowClaim={(claimId) => {
                setOpen(false);
                onShowClaim(claimId);
              }}
              runId={runId}
              workspaceId={workspaceId}
            />
          </SheetPanel>
        </SheetPopup>
      )}
    </Sheet>
  );
};

type ReviewerFilterProps = RunScope & {
  actorId: string | null;
  onChange: (actorId: string | null) => void;
};

/** The reviewers come from the run's unfiltered first page, so picking one
 *  never empties the list it was picked from. */
const ReviewerFilter = ({
  workspaceId,
  runId,
  actorId,
  onChange,
}: ReviewerFilterProps) => {
  const t = useTranslations();
  const history = useInfiniteQuery(
    reviewHistoryOptions({ workspaceId, runId }),
  );
  const view = queryView(history);
  // Every page names the same reviewers; past the cap the filter offers
  // only "any reviewer".
  const reviewers =
    view.type === "items"
      ? view.items.pages
          .slice(0, 1)
          .flatMap(({ reviewers: named }) =>
            named.type === "complete" ? named.items : [],
          )
      : [];
  return (
    <Select
      onValueChange={(value) =>
        onChange(value === null || value === ALL ? null : value)
      }
      value={actorId ?? ALL}
    >
      <SelectTrigger
        aria-label={t("avt.history.filters.reviewer")}
        className="min-w-40 flex-1"
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={ALL}>
          {t("avt.history.filters.allReviewers")}
        </SelectItem>
        {reviewers.map((reviewer) => (
          <SelectItem key={reviewer.id} value={reviewer.id}>
            {reviewer.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

type HistoryEntriesProps = RunScope & {
  filter: ReviewHistoryFilter;
  /** The run view names each entry's claim; a claim's own history does not. */
  claimText?: ReadonlyMap<VerificationClaim["id"], string>;
  onShowClaim?: (claimId: VerificationClaim["id"]) => void;
};

const HistoryEntries = ({
  workspaceId,
  runId,
  filter,
  claimText,
  onShowClaim,
}: HistoryEntriesProps) => {
  const t = useTranslations();
  const history = useInfiniteQuery(
    reviewHistoryOptions({ workspaceId, runId, ...filter }),
  );
  const view = queryView(history, {
    isEmpty: (data) => data.pages.every((page) => page.items.length === 0),
  });
  switch (view.type) {
    case "pending":
    case "error": {
      return <QueryViewFeedback view={view} />;
    }
    case "empty": {
      return (
        <p className="text-muted-foreground py-2 text-xs">
          {filter.kind === undefined && filter.actorId === undefined
            ? t("avt.history.empty")
            : t("avt.history.noMatches")}
        </p>
      );
    }
    case "items": {
      const entries = view.items.pages.flatMap((page) => page.items);
      return (
        <div className="space-y-2">
          <QueryViewFeedback view={view} />
          {groupHistoryByOrigin(entries).map((group) => (
            <section key={group.key}>
              {group.carriedFrom !== null && (
                <CarriedFromDivider carriedFrom={group.carriedFrom} />
              )}
              <ol className="divide-y">
                {group.entries.map((entry) => (
                  <HistoryEntryRow
                    claimText={claimText?.get(entry.claimId) ?? null}
                    entry={entry}
                    key={entry.id}
                    onShowClaim={onShowClaim}
                  />
                ))}
              </ol>
            </section>
          ))}
          {history.hasNextPage && (
            <Button
              className="w-full"
              loading={history.isFetchingNextPage}
              onClick={() => {
                detached(history.fetchNextPage(), "review-history.load-more");
              }}
              size="sm"
              variant="ghost"
            >
              {t("common.loadMore")}
            </Button>
          )}
        </div>
      );
    }
    default: {
      view satisfies never;
      return panic("Unhandled history view");
    }
  }
};

type HistoryEntryRowProps = {
  entry: ReviewHistoryEntry;
  claimText: string | null;
  onShowClaim: ((claimId: VerificationClaim["id"]) => void) | undefined;
};

const HistoryEntryRow = ({
  entry,
  claimText,
  onShowClaim,
}: HistoryEntryRowProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const changes = historyChanges(entry);
  const at = format.dateTime(
    Temporal.Instant.from(entry.createdAt).epochMilliseconds,
    MEDIUM_DATE_SHORT_TIME_FORMAT,
  );
  return (
    <li className="space-y-1.5 py-2.5 first:pt-1">
      <div className="flex items-center justify-between gap-2">
        {entry.actor.type === "member" ? (
          <UserIdentity
            as="span"
            avatarClassName="size-5 shrink-0"
            image={entry.actor.image}
            name={entry.actor.name}
            nameClassName="text-xs"
          />
        ) : (
          <UserIdentity
            as="span"
            avatarClassName="size-5 shrink-0"
            deleted
            name={t("avt.history.formerMember")}
            nameClassName="text-xs"
          />
        )}
        <time
          className="text-muted-foreground text-2xs shrink-0 tabular-nums"
          dateTime={entry.createdAt}
        >
          {at}
        </time>
      </div>
      <p className="text-xs font-medium">{t(historyActionKey(entry))}</p>
      {claimText !== null && onShowClaim !== undefined && (
        <Button
          className="max-w-full"
          onClick={() => onShowClaim(entry.claimId)}
          variant="plain"
        >
          <TruncatedText
            className="text-muted-foreground text-start font-serif text-xs hover:underline"
            dir="auto"
          >
            {claimText}
          </TruncatedText>
        </Button>
      )}
      {changes.length > 0 && (
        <div className="flex flex-col gap-1">
          {changes.map((change) => (
            <ChangeRow change={change} key={change.type} />
          ))}
        </div>
      )}
      <EntryReason entry={entry} />
    </li>
  );
};

/** One divider over the actions carried from an earlier run of the
 *  document, named as the run picker names that run. */
const CarriedFromDivider = ({
  carriedFrom,
}: {
  carriedFrom: NonNullable<ReviewHistoryEntry["carriedFrom"]>;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <div className="text-muted-foreground text-2xs flex items-center gap-2 pt-2 pb-1">
      <span className="shrink-0">
        {carriedFrom.runCreatedAt === null
          ? t("avt.history.carriedFromEarlier")
          : t("avt.history.carriedFrom", {
              date: format.dateTime(
                Temporal.Instant.from(carriedFrom.runCreatedAt)
                  .epochMilliseconds,
                MEDIUM_DATE_SHORT_TIME_FORMAT,
              ),
            })}
      </span>
      <span aria-hidden="true" className="bg-border h-px flex-1" />
    </div>
  );
};

const ChangeRow = ({ change }: { change: HistoryChange }) => (
  <div className="flex flex-wrap items-center gap-1.5">
    <ChangeBadge change={change} side="before" />
    <DirectionalIcon
      className="text-muted-foreground size-3"
      icon={ArrowRightIcon}
    />
    <ChangeBadge change={change} side="after" />
  </div>
);

const ChangeBadge = ({
  change,
  side,
}: {
  change: HistoryChange;
  side: "before" | "after";
}) => {
  const t = useTranslations();
  switch (change.type) {
    case "verdict": {
      const state = change[side];
      return (
        <ReviewStatusBadge tone={STATE_COLOR[state].tone}>
          {t(STATE_META[state].chipKey)}
        </ReviewStatusBadge>
      );
    }
    case "status": {
      const status = change[side];
      return status === null ? (
        <ReviewStatusBadge tone="neutral">
          {t("avt.history.noStatus")}
        </ReviewStatusBadge>
      ) : (
        <ReviewStatusBadge tone={REVIEW_STATUS_META[status].tone}>
          {t(REVIEW_STATUS_META[status].labelKey)}
        </ReviewStatusBadge>
      );
    }
    default: {
      change satisfies never;
      return panic("Unhandled history change");
    }
  }
};

const EntryReason = ({ entry }: { entry: ReviewHistoryEntry }) => {
  const t = useTranslations();
  const text = entryText(entry);
  if (text !== null) {
    return (
      <p
        className="text-muted-foreground border-s-2 ps-2 text-xs leading-relaxed whitespace-pre-wrap"
        dir="auto"
      >
        {text}
      </p>
    );
  }
  switch (entry.reason.type) {
    case "unrecorded": {
      return (
        <p className="text-muted-foreground text-2xs italic">
          {t("avt.history.reasonUnrecorded")}
        </p>
      );
    }
    case "none":
    case "given": {
      return null;
    }
    default: {
      entry.reason satisfies never;
      return panic("Unhandled history reason");
    }
  }
};

/** The words an entry quotes: a note is its own text and reads like a
 *  reason; otherwise the reason given, if any. */
const entryText = ({ action, reason }: ReviewHistoryEntry): string | null => {
  if (action.kind === "note" && action.note !== "") {
    return action.note;
  }
  return reason.type === "given" ? reason.text : null;
};
