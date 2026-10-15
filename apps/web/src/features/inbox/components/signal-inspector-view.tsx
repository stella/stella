import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { SIGNAL_KIND } from "@stll/api-contract/signals";
import type { SignalEvidence } from "@stll/api-contract/signals";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { UserText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { AlertCircleIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { MatterRefLink } from "@/components/matter-ref-link";
import type { InboxSignalViewPayload } from "@/features/inbox/signal-inspector.logic";
import {
  OPEN_WORK_STATUS_LABEL_KEY,
  ORIGIN_LABEL_KEY,
  scoutLabelKey,
  SEVERITY_DOT_CLASS,
  SEVERITY_LABEL_KEY,
  VERDICT_LABEL_KEY,
} from "@/features/inbox/signal-presentation";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import type { InboxSignal } from "@/lib/inbox/queries";
import { inboxSignalOptions } from "@/lib/inbox/queries";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

/** One inbox signal's evidence: the facts the card's claim rests on. */
export const SignalInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<InboxSignalViewPayload>) => {
  const t = useTranslations();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const {
    data: signal,
    isError,
    isPending,
    refetch,
  } = useQuery(
    inboxSignalOptions(activeOrganizationId, userId, tab.payload.signalId),
  );

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <InspectorTabHeader label={tab.label} onClose={onClose} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-4">
          {isPending && <EvidenceSkeleton />}
          {isError && (
            <div
              className="text-muted-foreground flex flex-col items-center gap-3 py-10 text-center text-sm"
              role="alert"
            >
              <AlertCircleIcon className="text-destructive size-8" />
              <p>{t("common.unexpectedError")}</p>
              <Button
                onClick={() => {
                  detached(refetch(), "inbox.refetch-signal-evidence");
                }}
                size="sm"
                variant="outline"
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
          {signal && <SignalHeader signal={signal} />}
          {signal && (
            <section className="flex flex-col gap-2">
              <h3 className="text-muted-foreground text-xs font-medium">
                {t("inbox.evidence.title")}
              </h3>
              <EvidenceBody evidence={signal.evidence} signal={signal} />
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

const SignalHeader = ({ signal }: { signal: InboxSignal }) => {
  const t = useTranslations();
  const format = useFormatter();
  const scoutKey = scoutLabelKey(signal.scoutKey);
  return (
    <header className="flex flex-col gap-1.5">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "size-2 rounded-full",
              SEVERITY_DOT_CLASS[signal.severity],
            )}
          />
          {t(SEVERITY_LABEL_KEY[signal.severity])}
        </span>
        <span aria-hidden>·</span>
        <span>{t(ORIGIN_LABEL_KEY[signal.origin])}</span>
        {scoutKey !== null && signal.origin !== "manual" && (
          <span>{t(scoutKey)}</span>
        )}
        {signal.confidence !== null && (
          <span className="tabular-nums">
            {t("inbox.confidence", {
              percent: format.number(signal.confidence, { style: "percent" }),
            })}
          </span>
        )}
        <span aria-hidden>·</span>
        <time dateTime={signal.createdAt}>
          {format.dateTime(
            new Date(signal.createdAt),
            MEDIUM_DATE_SHORT_TIME_FORMAT,
          )}
        </time>
      </div>
      <h2 className="text-base font-semibold text-balance">
        <UserText>{signal.title}</UserText>
      </h2>
      <UserText as="p" className="text-muted-foreground text-sm text-pretty">
        {signal.summary}
      </UserText>
      {signal.workspaceId !== null && (
        <MatterRefLink
          className="text-foreground text-xs underline-offset-2 hover:underline"
          workspaceId={signal.workspaceId}
        >
          {t("inbox.openMatter")}
        </MatterRefLink>
      )}
    </header>
  );
};

type EvidenceBodyProps = { evidence: SignalEvidence; signal: InboxSignal };

const EvidenceBody = ({ evidence, signal }: EvidenceBodyProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const formatDateTime = (iso: string) =>
    format.dateTime(new Date(iso), MEDIUM_DATE_SHORT_TIME_FORMAT);
  // A civil date carries no time zone; pinning the format to UTC keeps it on
  // the day the server recorded instead of shifting west of Greenwich.
  const formatDate = (date: string) =>
    format.dateTime(new Date(`${date}T00:00:00Z`), {
      dateStyle: "long",
      timeZone: "UTC",
    });

  switch (evidence.kind) {
    case SIGNAL_KIND.REQUEST_SUBMITTED:
      return (
        <div className="flex flex-col gap-3 text-sm">
          <UserText as="p" className="text-pretty whitespace-pre-wrap">
            {evidence.description}
          </UserText>
          <DetailsGrid>
            <DetailsItem label={t("emailViewer.attachments")}>
              {evidence.attachments.length === 0 ? (
                <span className="text-muted-foreground">
                  {t("inbox.evidence.noAttachments")}
                </span>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {evidence.attachments.map((attachment) => (
                    <li key={attachment.fileId}>
                      <UserText>{attachment.name}</UserText>
                    </li>
                  ))}
                </ul>
              )}
            </DetailsItem>
          </DetailsGrid>
        </div>
      );
    case SIGNAL_KIND.HEARING_CHANGED:
      return (
        <DetailsGrid>
          <DetailsItem label={t("common.court")}>
            <UserText>{evidence.courtName}</UserText>
          </DetailsItem>
          <DetailsItem label={t("caseLaw.columns.caseNumber")}>
            <UserText>{evidence.caseNumber}</UserText>
          </DetailsItem>
          {evidence.previousAt !== null && (
            <DetailsItem label={t("inbox.evidence.previous")}>
              <s className="text-muted-foreground">
                {formatDateTime(evidence.previousAt)}
              </s>
            </DetailsItem>
          )}
          <DetailsItem label={t("inbox.evidence.current")}>
            {formatDateTime(evidence.currentAt)}
          </DetailsItem>
          {evidence.hearingType !== null && (
            <DetailsItem label={t("inbox.evidence.hearingType")}>
              <UserText>{evidence.hearingType}</UserText>
            </DetailsItem>
          )}
          {evidence.sourceUrl !== null && (
            <DetailsItem label={t("common.source")} span="wide">
              <SourceLink url={evidence.sourceUrl} />
            </DetailsItem>
          )}
        </DetailsGrid>
      );
    case SIGNAL_KIND.DEADLINE_DETECTED:
      return (
        <DetailsGrid>
          <DetailsItem label={t("inbox.evidence.dueAt")}>
            {format.dateTime(new Date(evidence.dueAt), { dateStyle: "long" })}
          </DetailsItem>
          <DetailsItem label={t("common.name")}>
            <UserText>{evidence.label}</UserText>
          </DetailsItem>
          <DetailsItem label={t("common.document")}>
            <DocumentRef
              entityId={evidence.entityId}
              name={evidence.entityName}
              signal={signal}
            />
          </DetailsItem>
          <DetailsItem label={t("inbox.evidence.quote")} span="wide">
            <blockquote className="border-s-2 ps-3 text-pretty italic">
              <UserText>{evidence.quote}</UserText>
            </blockquote>
          </DetailsItem>
        </DetailsGrid>
      );
    case SIGNAL_KIND.CONTRACT_REVIEWED:
      return (
        <dl className="flex flex-col gap-2 text-sm">
          <Row label={t("inbox.evidence.verdict")}>
            <span
              className={cn(
                "rounded-sm px-1.5 py-0.5 text-xs font-medium",
                evidence.verdict === "safe" && "bg-success/15 text-success",
                evidence.verdict === "needs-review" &&
                  "bg-warning/15 text-warning",
                evidence.verdict === "reject" &&
                  "bg-destructive/15 text-destructive",
              )}
            >
              {t(VERDICT_LABEL_KEY[evidence.verdict])}
            </span>
          </Row>
          <Row label={t("common.document")}>
            <DocumentRef
              entityId={evidence.entityId}
              name={evidence.entityName}
              signal={signal}
            />
          </Row>
          <Row label={t("inbox.evidence.findings")}>
            {evidence.findings.length === 0 ? (
              <span className="text-muted-foreground">{t("common.none")}</span>
            ) : (
              <ul className="flex flex-col gap-2">
                {evidence.findings.map((finding) => (
                  <li
                    className="flex flex-col gap-0.5"
                    key={`${finding.severity}:${finding.title}`}
                  >
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          SEVERITY_DOT_CLASS[finding.severity],
                        )}
                      />
                      <UserText>{finding.title}</UserText>
                    </span>
                    {finding.quote.length > 0 && (
                      <blockquote className="text-muted-foreground border-s-2 ps-3 text-xs text-pretty italic">
                        <UserText>{finding.quote}</UserText>
                      </blockquote>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Row>
        </dl>
      );
    case SIGNAL_KIND.WORK_UNACKNOWLEDGED:
      return (
        <DetailsGrid>
          <DetailsItem label={t("tasks.assigned")}>
            {formatDateTime(evidence.assignedAt)}
          </DetailsItem>
          <DetailsItem label={t("inbox.evidence.daysUnacknowledged")}>
            {format.number(evidence.daysWaiting)}
          </DetailsItem>
          {evidence.workingTargetDate !== null && (
            <DetailsItem label={t("tasks.workingTarget")}>
              {formatDate(evidence.workingTargetDate)}
            </DetailsItem>
          )}
          {evidence.hardDeadlineDate !== null && (
            <DetailsItem label={t("tasks.hardDeadline")}>
              {formatDate(evidence.hardDeadlineDate)}
            </DetailsItem>
          )}
        </DetailsGrid>
      );
    case SIGNAL_KIND.WORK_DEADLINE_AT_RISK:
      return (
        <DetailsGrid>
          <DetailsItem label={t("tasks.hardDeadline")}>
            {formatDate(evidence.hardDeadlineDate)}
          </DetailsItem>
          <DetailsItem
            label={t(
              evidence.daysUntilDeadline < 0
                ? "inbox.evidence.daysOverdue"
                : "inbox.evidence.daysUntilDeadline",
            )}
          >
            {format.number(Math.abs(evidence.daysUntilDeadline))}
          </DetailsItem>
          {evidence.workingTargetDate !== null && (
            <DetailsItem label={t("tasks.workingTarget")}>
              {formatDate(evidence.workingTargetDate)}
            </DetailsItem>
          )}
          <DetailsItem label={t("tasks.status")}>
            {t(OPEN_WORK_STATUS_LABEL_KEY[evidence.obligationStatus])}
          </DetailsItem>
        </DetailsGrid>
      );
    default: {
      evidence satisfies never;
      return panic(`Unhandled evidence: ${String(evidence)}`);
    }
  }
};

const DocumentRef = ({
  entityId,
  name,
  signal,
}: {
  entityId: string;
  name: string;
  signal: InboxSignal;
}) => {
  if (signal.workspaceId === null) {
    return <UserText>{name}</UserText>;
  }

  const workspaceId = signal.workspaceId;
  return (
    <button
      className="text-start underline-offset-2 hover:underline"
      onClick={() => {
        detached(
          openEntityInInspector(entityId, name, workspaceId),
          "inbox.open-evidence-entity",
        );
      }}
      type="button"
    >
      <UserText>{name}</UserText>
    </button>
  );
};

const SourceLink = ({ url }: { url: string }) =>
  sanitizeHref(url) === undefined ? (
    <span dir="ltr">{url}</span>
  ) : (
    <a
      className="underline-offset-2 hover:underline"
      dir="ltr"
      href={sanitizeHref(url)}
      rel="noreferrer"
      target="_blank"
    >
      {url}
    </a>
  );

const Row = ({
  label,
  children,
}: React.PropsWithChildren<{ label: string }>) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd>{children}</dd>
  </div>
);

const EvidenceSkeleton = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-3 w-40" />
    <Skeleton className="h-5 w-64" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
  </div>
);
