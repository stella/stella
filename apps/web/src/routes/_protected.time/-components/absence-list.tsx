import { useId, useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { ABSENCE_STATUSES } from "@stll/api-contract";
import { Temporal } from "@stll/time";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ReviewCommentCard } from "@stll/ui/review-comment-card";
import { ReviewDecisionActions } from "@stll/ui/review-decision-actions";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";

import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  absencesApprovalQueueInfiniteOptions,
  absencesMineInfiniteOptions,
  useDecideAbsence,
} from "@/lib/organization/absences";
import type { AbsenceEntry } from "@/lib/organization/absences";
import { organizationOptions } from "@/lib/organization/queries";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";

import { AbsenceDecisionForm } from "./absence-decision-form";

const ABSENCE_STATUS_TONES = {
  requested: "neutral",
  approved: "success",
  rejected: "destructive",
  cancelled: "neutral",
} as const satisfies Record<
  (typeof ABSENCE_STATUSES)[number],
  ReviewStatusTone
>;

const ABSENCE_STATUS_LABELS = {
  requested: "billing.absences.statuses.requested",
  approved: "billing.statuses.approved",
  rejected: "flows.runs.review.rejected",
  cancelled: "tasks.statusValues.cancelled",
} as const satisfies Record<(typeof ABSENCE_STATUSES)[number], TranslationKey>;

const dateInstant = (date: string) =>
  Temporal.PlainDate.from(date).toZonedDateTime({
    plainTime: Temporal.PlainTime.from("00:00"),
    timeZone: "UTC",
  }).epochMilliseconds;

type AbsenceRowProps = {
  entry: AbsenceEntry;
  review: boolean;
  ownerName: string | null;
  approverName: string | null;
};

const AbsenceSummary = ({
  entry,
  review,
  ownerName,
}: Pick<AbsenceRowProps, "entry" | "review" | "ownerName">) => {
  const t = useTranslations();
  const format = useFormatter();
  const first = dateInstant(entry.startDate);
  const last = dateInstant(
    Temporal.PlainDate.from(entry.endDate).subtract({ days: 1 }).toString(),
  );
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 space-y-1">
        {review && (
          <p className="text-sm font-medium">
            <BidiText>
              {ownerName ??
                (entry.userId === null
                  ? t("billing.absences.formerMember")
                  : t("billing.absences.unknownMember"))}
            </BidiText>
            {ownerName === null && entry.userId !== null && (
              <bdi className="text-muted-foreground ms-2 text-xs">
                {entry.userId}
              </bdi>
            )}
          </p>
        )}
        <p className="text-sm">
          {t(`timesheets.day.absenceKinds.${entry.kind}`)}
        </p>
        <p className="text-muted-foreground text-sm">
          {first === last
            ? format.dateTime(first, { ...MEDIUM_DATE_FORMAT, timeZone: "UTC" })
            : format.dateTimeRange(first, last, {
                ...MEDIUM_DATE_FORMAT,
                timeZone: "UTC",
              })}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <ReviewStatusBadge tone={ABSENCE_STATUS_TONES[entry.status]}>
          {t(ABSENCE_STATUS_LABELS[entry.status])}
        </ReviewStatusBadge>
        <span className="text-sm tabular-nums">
          {format.number(entry.days, {
            style: "unit",
            unit: "day",
            unitDisplay: "long",
          })}
        </span>
        {entry.coverage === "half" && entry.halfDaySegment !== null && (
          <span className="text-muted-foreground text-xs">
            {t(`timesheets.day.halfDaySegments.${entry.halfDaySegment}`)}
          </span>
        )}
      </div>
    </div>
  );
};

const AbsenceRow = ({
  entry,
  review,
  ownerName,
  approverName,
}: AbsenceRowProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const user = useAuthenticatedUser();
  const decision = useDecideAbsence(user.activeOrganizationId);
  const canCancel = usePermissions({ timeEntry: ["update"] });
  const [editing, setEditing] = useState<"approve" | "reject" | null>(null);
  return (
    <li className="space-y-3 py-4">
      <AbsenceSummary entry={entry} review={review} ownerName={ownerName} />
      {entry.decisionComment !== null && entry.decidedAt !== null && (
        <ReviewCommentCard
          author={{
            name:
              approverName ??
              (entry.approverUserId === null
                ? t("billing.absences.formerMember")
                : t("billing.absences.unknownMember")),
          }}
          timestamp={entry.decidedAt}
          formattedTime={format.dateTime(
            Temporal.Instant.from(entry.decidedAt).epochMilliseconds,
            MEDIUM_DATE_FORMAT,
          )}
          body={
            <p dir="auto" className="text-sm whitespace-pre-wrap">
              {entry.decisionComment}
            </p>
          }
        />
      )}
      {entry.status === "requested" && !review && canCancel && (
        <div className="flex justify-end">
          <Button
            className="min-h-11"
            variant="ghost"
            disabled={decision.isPending}
            onClick={() =>
              decision.mutate({
                id: entry.id,
                version: entry.version,
                action: "cancel",
              })
            }
          >
            {t("common.cancel")}
          </Button>
        </div>
      )}
      {review && entry.userId !== null && editing === null && (
        <ReviewDecisionActions
          state="pending"
          onAccept={() => setEditing("approve")}
          onReject={() => setEditing("reject")}
          acceptLabel={t("billing.approve")}
          rejectLabel={t("docxReview.reject")}
          className="justify-end [&_button]:min-h-11"
        />
      )}
      {editing !== null && (
        <AbsenceDecisionForm
          entry={entry}
          action={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </li>
  );
};

export const AbsenceList = ({ review = false }: { review?: boolean }) => {
  const headingId = useId();
  const user = useAuthenticatedUser();
  const t = useTranslations();
  const query = useInfiniteQuery(
    review
      ? absencesApprovalQueueInfiniteOptions(user.activeOrganizationId, user.id)
      : absencesMineInfiniteOptions(user.activeOrganizationId, user.id),
  );
  const organization = useQuery({
    ...organizationOptions(user.activeOrganizationId),
    enabled: review,
  });
  const entries = query.isSuccess
    ? query.data.pages.flatMap((page) => page.items)
    : [];
  const memberName = (id: string | null) =>
    id === user.id
      ? (user.name ?? null)
      : (organization.data?.members.find(
          (membership) => membership.userId === id,
        )?.user.name ?? null);
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="text-sm font-medium">
        {review
          ? t("billing.absences.approvalQueue")
          : t("billing.absences.mine")}
      </h3>
      {query.isPending && (
        <p role="status" className="text-muted-foreground text-sm">
          {t("common.loading")}
        </p>
      )}
      {query.isError && (
        <div role="alert" className="space-y-2">
          <p className="text-destructive text-sm">
            {userErrorFromThrown(query.error, t("errors.actionFailed"))}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => detached(query.refetch(), "absences.retry")}
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {review && organization.isError && (
        <div role="alert" className="space-y-2">
          <p className="text-destructive text-sm">
            {userErrorFromThrown(organization.error, t("errors.actionFailed"))}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() =>
              detached(organization.refetch(), "absences.members-retry")
            }
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {!query.isPending && !query.isError && entries.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {review
            ? t("billing.absences.emptyQueue")
            : t("billing.absences.emptyMine")}
        </p>
      )}
      {entries.length > 0 && (
        <ul className="divide-y">
          {entries.map((entry) => (
            <AbsenceRow
              key={entry.id}
              entry={entry}
              review={review}
              ownerName={memberName(entry.userId)}
              approverName={memberName(entry.approverUserId)}
            />
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <Button
          className="min-h-11"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => detached(query.fetchNextPage(), "absences.load-more")}
        >
          {query.isFetchingNextPage
            ? t("common.loading")
            : t("common.loadMore")}
        </Button>
      )}
    </section>
  );
};
