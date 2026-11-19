import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import {
  plainDateEpoch,
  SHORT_DATE,
} from "@/components/billing/format-plain-date";
import { WeekNavigator } from "@/components/billing/week-navigator";
import { todayIn, weekOf } from "@/components/billing/work-week.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { ReturnSelected } from "@/features/time-review/return-selected";
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
import { queryView, queryViewError } from "@/lib/query-view.logic";
import { formatMinutes } from "@/lib/workspaces/format-duration";
import {
  type TimeApprovalItem,
  timeApprovalsQuery,
} from "@/lib/workspaces/queries/time-approvals";

import {
  TimeApprovalDay,
  TimeApprovalFilterFaces,
  TimeApprovalFilters,
  TimeApprovalPeopleSkeleton,
  TimeApprovalPerson,
  TimeApprovalPersonHeader,
  TimeApprovalsShell,
} from "./-time-approvals.pending";

const route = getRouteApi("/_protected/time_/approvals");

type TimeApprovalsFilter = {
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
    <TimeApprovalPerson label={person.timekeeperName ?? undefined}>
      <TimeApprovalPersonHeader
        summary={
          <>
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
          </>
        }
        actions={
          <>
            <ReturnSelected review={review} selected={selected} />
            <Button
              loading={target.some(({ id }) => review.isPending(id))}
              onClick={() => review.approve(target)}
              size="sm"
            >
              {selected.length > 0
                ? t("billing.approval.approveSelected", {
                    count: selected.length,
                  })
                : t("billing.approval.approveAll", { count: rows.length })}
            </Button>
          </>
        }
      />
      {person.days.map((day) => (
        <TimeApprovalDay
          date={format.dateTime(plainDateEpoch(day.date), SHORT_DATE)}
          key={day.date}
        >
          {day.rows.map((row) => (
            <TimeReviewRow
              key={row.id}
              review={review}
              row={row}
              show={{ timekeeper: false, matter: true, date: false }}
              stage="submitted"
            />
          ))}
        </TimeApprovalDay>
      ))}
    </TimeApprovalPerson>
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
  const week = weekOf(filter.date);
  const queue = useInfiniteQuery({
    ...timeApprovalsQuery(organizationId, userId, week, filter),
    placeholderData: keepPreviousData,
  });
  const review = useTimeReview();
  const view = queryView(queue);
  const failed =
    !queue.isFetchNextPageError && queryViewError(view) !== undefined;
  const rows =
    view.type === "items"
      ? view.items.pages.flatMap((page) => page.items.map(reviewRowOf))
      : [];
  const waiting = view.type === "pending" || queue.isPlaceholderData;
  const people = waiting ? [] : groupForReview(rows, locale);
  const showFilterChips =
    rows.length > 0 ||
    filter.member !== undefined ||
    filter.matter !== undefined;

  return (
    <TimeApprovalsShell
      navigator={
        <WeekNavigator
          date={filter.date}
          onSelectDate={(date) => onFilterChange({ ...filter, date })}
          onToday={onThisWeek}
        />
      }
      title={t("billing.approval.title")}
    >
      {/* An active filter keeps its controls even when nothing matches,
          so it can always be cleared. */}
      {showFilterChips && (
        <TimeApprovalFilters>
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
        </TimeApprovalFilters>
      )}
      {!showFilterChips && waiting && <TimeApprovalFilterFaces />}
      {waiting && <TimeApprovalPeopleSkeleton />}
      {failed && <QueryViewFeedback view={view} />}
      {!waiting && !failed && people.length === 0 && (
        <p className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">
          {t("billing.approval.emptyWeek")}
        </p>
      )}
      {people.map((person) => (
        <PersonSection
          key={person.timekeeperId ?? ""}
          person={person}
          review={review}
        />
      ))}
      {!waiting && queue.hasNextPage && (
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
    </TimeApprovalsShell>
  );
};

export function TimeApprovalsRoute() {
  const search = route.useSearch({
    select: ({ date, member, matter }) => ({ date, member, matter }),
  });
  const { organizationId, userId, timezoneId } = route.useRouteContext({
    select: (context) => ({
      organizationId: context.user.activeOrganizationId,
      userId: context.user.id,
      timezoneId: context.user.timezoneId,
    }),
  });
  const navigate = route.useNavigate();

  return (
    <TimeApprovalsPage
      filter={{
        date: search.date ?? todayIn(timezoneId),
        member: search.member,
        matter: search.matter,
      }}
      onFilterChange={(filter) =>
        detached(
          navigate({
            search: {
              date: filter.date,
              ...(filter.member === undefined ? {} : { member: filter.member }),
              ...(filter.matter === undefined ? {} : { matter: filter.matter }),
            },
          }),
          "time-approvals.navigate",
        )
      }
      onThisWeek={() =>
        detached(navigate({ search: {} }), "time-approvals.this-week")
      }
      organizationId={organizationId}
      userId={userId}
    />
  );
}
