import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import {
  plainDateEpoch,
  SHORT_DATE,
} from "@/components/billing/format-plain-date";
import {
  shiftWeeks,
  type Week,
  weekOf,
} from "@/features/my-week/my-week.logic";
import {
  groupForReview,
  type PersonReview,
  type ReviewRowWithPerson,
} from "@/features/time-review/time-approvals.logic";
import { TimeReviewRow } from "@/features/time-review/time-review-row";
import {
  type TimeReview,
  useTimeReview,
} from "@/features/time-review/use-time-review";
import { useFormatter } from "@/i18n/formatting-context";
import { useMessageLocale } from "@/i18n/message-locale";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { formatMinutes } from "@/lib/workspaces/format-duration";
import {
  type TimeApprovalItem,
  timeApprovalQueueOptions,
} from "@/lib/workspaces/queries/time-approvals";

export type TimeApprovalsFilter = {
  /** Any day of the reviewed week. */
  date: string;
  member: string | undefined;
  matter: string | undefined;
};

type TimeApprovalsPageProps = {
  organizationId: string;
  userId: string;
  filter: TimeApprovalsFilter;
  onFilterChange: (filter: TimeApprovalsFilter) => void;
  onThisWeek: () => void;
};

/** The queue the page reads: one week, everyone the approver reviews. */
export const timeApprovalsQuery = (
  organizationId: string,
  userId: string,
  week: Week,
) =>
  timeApprovalQueueOptions(organizationId, userId, {
    from: week.start,
    to: week.end,
  });

const reviewRowOf = (item: TimeApprovalItem): ReviewRowWithPerson => ({
  id: item.id,
  workspaceId: item.workspaceId,
  timekeeperId: item.userId,
  timekeeperName: item.timekeeperName,
  matterName: item.matterName,
  dateWorked: item.dateWorked,
  durationMinutes: item.durationMinutes,
  billedMinutes: item.billedMinutes,
  rateAtEntry: item.rateAtEntry,
  currency: item.currency,
  billable: item.billable,
  noCharge: item.noCharge,
  narrative: item.narrative,
  returnComment: item.returnComment,
});

type FilterOption = { value: string | undefined; label: string };

const FilterChips = ({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: readonly FilterOption[];
  selected: string | undefined;
  onSelect: (value: string | undefined) => void;
}) => (
  <div aria-label={label} className="flex flex-wrap gap-1" role="group">
    {options.map((option) => (
      <Button
        aria-pressed={option.value === selected}
        key={option.value ?? ""}
        onClick={() => onSelect(option.value)}
        size="sm"
        variant={option.value === selected ? "secondary" : "ghost"}
      >
        <BidiText as="span">{option.label}</BidiText>
      </Button>
    ))}
  </div>
);

const PersonSection = ({
  person,
  review,
}: {
  person: PersonReview;
  review: TimeReview;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const rows = person.days.flatMap((day) => day.rows);
  // Checked entries narrow the approval; with none checked it covers them all.
  const selected = review.selectedOf(rows);
  const target = selected.length > 0 ? selected : rows;
  return (
    <section
      aria-label={person.timekeeperName ?? undefined}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{person.timekeeperName}</h2>
          <p className="text-muted-foreground text-xs tabular-nums">
            {[
              t("billing.approval.billedTotal", {
                duration: formatMinutes(person.billedMinutes),
              }),
              ...person.amounts.map(({ currency, amount }) =>
                formatCurrencyAmount(amount, currency),
              ),
            ].join(" · ")}
          </p>
        </div>
        <Button
          loading={target.some(({ id }) => review.isPending(id))}
          onClick={() => review.approve(target)}
          size="sm"
        >
          {selected.length > 0
            ? t("billing.approval.approveSelected", { count: selected.length })
            : t("billing.approval.approveAll", { count: rows.length })}
        </Button>
      </div>
      {person.days.map((day) => (
        <div className="flex flex-col gap-2" key={day.date}>
          <h3 className="text-muted-foreground text-xs font-medium">
            {format.dateTime(plainDateEpoch(day.date), SHORT_DATE)}
          </h3>
          <ul className="flex flex-col gap-2">
            {day.rows.map((row) => (
              <TimeReviewRow
                key={row.id}
                review={review}
                row={row}
                show={{ timekeeper: false, matter: true, date: false }}
                stage="submitted"
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
};

const optionsOf = (
  rows: readonly ReviewRowWithPerson[],
  key: (row: ReviewRowWithPerson) => { value: string | null; label: string },
) => {
  const options = new Map<string, string>();
  for (const row of rows) {
    const { value, label } = key(row);
    if (value !== null) {
      options.set(value, label);
    }
  }
  return [...options].map(([value, label]) => ({ value, label }));
};

/**
 * Submitted time for one week from everyone whose time the signed-in person
 * approves, grouped by person and day, with each person's totals. Approve a
 * person's week at once or entry by entry; return an entry with a reason.
 */
export const TimeApprovalsPage = ({
  organizationId,
  userId,
  filter,
  onFilterChange,
  onThisWeek,
}: TimeApprovalsPageProps) => {
  const t = useTranslations();
  const locale = useMessageLocale();
  const format = useFormatter();
  const week = weekOf(filter.date);
  const queue = useSuspenseInfiniteQuery(
    timeApprovalsQuery(organizationId, userId, week),
  );
  const review = useTimeReview();
  const rows = queue.data.pages.flatMap((page) => page.items.map(reviewRowOf));
  const visible = rows.filter(
    (row) =>
      (filter.member === undefined || row.timekeeperId === filter.member) &&
      (filter.matter === undefined || row.workspaceId === filter.matter),
  );
  const people = groupForReview(visible, locale);
  const moveTo = (weeks: number) =>
    onFilterChange({ ...filter, date: shiftWeeks(filter.date, weeks) });

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-medium">{t("billing.approval.title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onThisWeek} size="sm" variant="outline">
            {t("common.today")}
          </Button>
          <Button
            aria-label={t("timesheets.week.previousWeek")}
            className="size-11"
            onClick={() => moveTo(-1)}
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
          </Button>
          <span className="min-w-36 text-center text-sm tabular-nums">
            {t("timesheets.week.range", {
              start: format.dateTime(plainDateEpoch(week.start), SHORT_DATE),
              end: format.dateTime(plainDateEpoch(week.end), SHORT_DATE),
            })}
          </span>
          <Button
            aria-label={t("timesheets.week.nextWeek")}
            className="size-11"
            onClick={() => moveTo(1)}
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
          </Button>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4">
          {rows.length > 0 && (
            <div className="flex flex-col gap-2">
              <FilterChips
                label={t("workspaces.properties.person")}
                onSelect={(member) => onFilterChange({ ...filter, member })}
                options={[
                  { value: undefined, label: t("billing.approval.everyone") },
                  ...optionsOf(rows, (row) => ({
                    value: row.timekeeperId,
                    label: row.timekeeperName ?? "",
                  })),
                ]}
                selected={filter.member}
              />
              <FilterChips
                label={t("common.matter")}
                onSelect={(matter) => onFilterChange({ ...filter, matter })}
                options={[
                  {
                    value: undefined,
                    label: t("inspector.matterPicker.allMatters"),
                  },
                  ...optionsOf(rows, (row) => ({
                    value: row.workspaceId,
                    label: row.matterName ?? "",
                  })),
                ]}
                selected={filter.matter}
              />
            </div>
          )}
          {people.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">
              {t("billing.approval.emptyWeek")}
            </p>
          ) : (
            people.map((person) => (
              <PersonSection
                key={person.timekeeperId ?? ""}
                person={person}
                review={review}
              />
            ))
          )}
          {queue.hasNextPage && (
            <div className="flex justify-center">
              <Button
                disabled={queue.isFetchingNextPage}
                onClick={() =>
                  detached(
                    (async () => {
                      const page = await queue.fetchNextPage();
                      // Loaded entries stay; the failure is said, and the
                      // button stays to retry.
                      if (page.isFetchNextPageError) {
                        notifyUserError(page.error, t("errors.actionFailed"));
                      }
                    })(),
                    "time-approvals.next-page",
                  )
                }
                size="sm"
                variant="outline"
              >
                {t("common.loadMore")}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
