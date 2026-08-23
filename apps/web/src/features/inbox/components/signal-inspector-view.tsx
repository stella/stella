import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { AlertCircleIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { SIGNAL_KIND } from "@stll/api-contract/signals";
import type { SignalEvidence } from "@stll/api-contract/signals";
import { UserText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { MatterRefLink } from "@/components/matter-ref-link";
import type { InboxSignalViewPayload } from "@/features/inbox/signal-inspector.logic";
import {
  ORIGIN_LABEL_KEY,
  scoutLabelKey,
  SEVERITY_DOT_CLASS,
  SEVERITY_LABEL_KEY,
  VERDICT_LABEL_KEY,
} from "@/features/inbox/signal-presentation";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import type { InboxSignal } from "@/lib/inbox/queries";
import { inboxSignalOptions } from "@/lib/inbox/queries";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { sanitizeHref } from "@/lib/sanitize-href";

const protectedRouteApi = getRouteApi("/_protected");

/** One inbox signal's evidence: the facts the card's claim rests on. */
export const SignalInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<InboxSignalViewPayload>) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const {
    data: signal,
    isError,
    isPending,
    refetch,
  } = useQuery(inboxSignalOptions(activeOrganizationId, tab.payload.signalId));

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
              percent: Math.round(signal.confidence * 100),
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
      <h2 className="text-base font-semibold text-balance">{signal.title}</h2>
      <p className="text-muted-foreground text-sm text-pretty">
        {signal.summary}
      </p>
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

  switch (evidence.kind) {
    case SIGNAL_KIND.REQUEST_SUBMITTED:
      return (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-pretty whitespace-pre-wrap">
            {evidence.description}
          </p>
          <Row label={t("emailViewer.attachments")}>
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
          </Row>
        </div>
      );
    case SIGNAL_KIND.HEARING_CHANGED:
      return (
        <dl className="flex flex-col gap-2 text-sm">
          <Row label={t("caseLaw.columns.court")}>{evidence.courtName}</Row>
          <Row label={t("caseLaw.columns.caseNumber")}>
            <UserText>{evidence.caseNumber}</UserText>
          </Row>
          {evidence.previousAt !== null && (
            <Row label={t("inbox.evidence.previous")}>
              <s className="text-muted-foreground">
                {formatDateTime(evidence.previousAt)}
              </s>
            </Row>
          )}
          <Row label={t("inbox.evidence.current")}>
            {formatDateTime(evidence.currentAt)}
          </Row>
          {evidence.hearingType !== null && (
            <Row label={t("inbox.evidence.hearingType")}>
              {evidence.hearingType}
            </Row>
          )}
          {evidence.sourceUrl !== null && (
            <Row label={t("common.source")}>
              <SourceLink url={evidence.sourceUrl} />
            </Row>
          )}
        </dl>
      );
    case SIGNAL_KIND.DEADLINE_DETECTED:
      return (
        <dl className="flex flex-col gap-2 text-sm">
          <Row label={t("inbox.evidence.dueAt")}>
            {format.dateTime(new Date(evidence.dueAt), { dateStyle: "long" })}
          </Row>
          <Row label={t("common.name")}>{evidence.label}</Row>
          <Row label={t("common.document")}>
            <DocumentRef name={evidence.entityName} signal={signal} />
          </Row>
          <Row label={t("inbox.evidence.quote")}>
            <blockquote className="border-s-2 ps-3 text-pretty italic">
              {evidence.quote}
            </blockquote>
          </Row>
        </dl>
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
            <DocumentRef name={evidence.entityName} signal={signal} />
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
                      {finding.title}
                    </span>
                    {finding.quote.length > 0 && (
                      <blockquote className="text-muted-foreground border-s-2 ps-3 text-xs text-pretty italic">
                        {finding.quote}
                      </blockquote>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Row>
        </dl>
      );
    default: {
      const exhaustive: never = evidence;
      return exhaustive;
    }
  }
};

const DocumentRef = ({
  name,
  signal,
}: {
  name: string;
  signal: InboxSignal;
}) =>
  signal.workspaceId === null ? (
    <UserText>{name}</UserText>
  ) : (
    <MatterRefLink
      className="underline-offset-2 hover:underline"
      workspaceId={signal.workspaceId}
    >
      <UserText>{name}</UserText>
    </MatterRefLink>
  );

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
