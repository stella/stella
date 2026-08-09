import { Fragment, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, PaperclipIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { Skeleton } from "@stll/ui/components/skeleton";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { DocumentIcon } from "@/components/document-icon";
import {
  getEmailAttachmentSize,
  localizeEmailBodyHtml,
  parseEmailDate,
  type EmailBodyFoldLabels,
} from "@/components/inspector/email-html-viewer.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { EMAIL_BODY_FOLD_KIND } from "@/lib/files/email-preview";
import { emailHtmlPreviewOptions } from "@/lib/files/queries";
import { formatFullTimestamp } from "@/lib/relative-time";

type EmailHtmlViewerProps = {
  fieldId: string;
  workspaceId: string;
};

type EmailFileViewerProps = EmailHtmlViewerProps & {
  entityId: string;
  fileName: string;
};

export const EmailFileViewer = ({
  entityId,
  fieldId,
  fileName,
  workspaceId,
}: EmailFileViewerProps) => (
  <FileViewerWithAI
    activeFile={{ entityId, fileFieldId: fieldId, fileName }}
    workspaceId={workspaceId}
  >
    <EmailHtmlViewer fieldId={fieldId} workspaceId={workspaceId} />
  </FileViewerWithAI>
);

export const EmailHtmlViewer = ({
  fieldId,
  workspaceId,
}: EmailHtmlViewerProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const previewQuery = useQuery(
    emailHtmlPreviewOptions({ workspaceId, fieldId }),
  );

  if (previewQuery.isPending) {
    return (
      <div
        aria-label={t("common.loading")}
        className="bg-muted/30 flex min-h-0 flex-1 flex-col gap-2 p-3"
        role="status"
      >
        <Skeleton className="h-24 w-full rounded-sm" />
        <Skeleton className="min-h-0 flex-1 rounded-sm" />
      </div>
    );
  }

  if (previewQuery.isError) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        role="alert"
      >
        <AlertTriangleIcon className="text-foreground-disabled size-8" />
        <p className="text-muted-foreground text-sm">
          {t("common.somethingWentWrong")}
        </p>
        <Button
          onClick={() => {
            detached(previewQuery.refetch(), "EmailHtmlViewer");
          }}
          size="sm"
          variant="outline"
        >
          {t("common.tryAgain")}
        </Button>
      </div>
    );
  }

  const preview = previewQuery.data;
  const subject = preview.subject?.trim() || t("emailViewer.noSubject");
  const parsedDate = parseEmailDate(preview.date);
  const formattedDate = parsedDate
    ? formatFullTimestamp(parsedDate)
    : preview.date;
  const hasAdditionalParticipants =
    preview.cc.length > 0 || preview.bcc.length > 0;
  const attachmentKeyOccurrences = new Map<string, number>();
  const bodyHtml = localizeEmailBodyHtml({
    bodyFolds: preview.bodyFolds,
    bodyHtml: preview.bodyHtml,
    labels: {
      [EMAIL_BODY_FOLD_KIND.quotedHistory]: {
        hide: t("emailViewer.hideQuotedHistory"),
        show: t("emailViewer.showQuotedHistory"),
      },
      [EMAIL_BODY_FOLD_KIND.signature]: {
        hide: t("emailViewer.hideSignature"),
        show: t("emailViewer.showSignature"),
      },
    } satisfies EmailBodyFoldLabels,
  });

  return (
    <article className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="bg-background max-h-[45%] shrink-0 overflow-y-auto overscroll-contain border-b px-4 py-3">
        <h1 className="text-foreground text-base font-semibold text-balance">
          <BidiText as="span">{subject}</BidiText>
        </h1>
        <dl className="mt-3 grid min-w-0 gap-1.5 text-xs">
          <EmailParticipantRow
            label={t("emailViewer.from")}
            values={preview.from ? [preview.from] : []}
          />
          <EmailParticipantRow
            label={t("emailViewer.to")}
            values={preview.to}
          />
          {formattedDate ? (
            <div className="text-muted-foreground grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3">
              <dt>{t("common.date")}</dt>
              <dd className="min-w-0 truncate">
                <time dateTime={parsedDate?.toISOString()}>
                  {formattedDate}
                </time>
              </dd>
            </div>
          ) : null}
        </dl>
        {hasAdditionalParticipants ? (
          <details
            className="mt-2 text-xs"
            onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
          >
            <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 cursor-pointer items-center rounded-md py-2 text-start underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none">
              {detailsOpen ? t("common.hideDetails") : t("common.showDetails")}
            </summary>
            <dl className="grid gap-1.5 pb-1">
              <EmailParticipantRow
                label={t("emailViewer.cc")}
                values={preview.cc}
              />
              <EmailParticipantRow
                label={t("emailViewer.bcc")}
                values={preview.bcc}
              />
            </dl>
          </details>
        ) : null}
        {preview.attachments.length > 0 ? (
          <section
            aria-labelledby={`${fieldId}-attachments`}
            className="mt-3 border-t pt-3"
          >
            <h2
              className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium"
              id={`${fieldId}-attachments`}
            >
              <PaperclipIcon aria-hidden="true" className="size-3.5" />
              {t("emailViewer.attachments")}
            </h2>
            <ul className="flex flex-wrap gap-1.5">
              {preview.attachments.map((attachment) => (
                <li
                  className="bg-muted/50 inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs"
                  key={getAttachmentKey(attachment, attachmentKeyOccurrences)}
                >
                  <DocumentIcon
                    className="text-muted-foreground size-4 shrink-0"
                    fileName={
                      attachment.fileName ?? t("emailViewer.unnamedAttachment")
                    }
                    mimeType={attachment.mimeType ?? "application/octet-stream"}
                  />
                  <BidiText as="span" className="max-w-48 min-w-0 truncate">
                    {attachment.fileName ?? t("emailViewer.unnamedAttachment")}
                  </BidiText>
                  {attachment.sizeBytes > 0 ? (
                    <span className="text-muted-foreground shrink-0">
                      {formatAttachmentSize(attachment.sizeBytes, format)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </header>
      <div className="bg-muted/30 min-h-0 min-w-0 flex-1 overflow-hidden p-2">
        <iframe
          className="bg-background size-full border-0"
          referrerPolicy="no-referrer"
          sandbox=""
          srcDoc={bodyHtml}
          title={t("emailViewer.bodyTitle")}
        />
      </div>
    </article>
  );
};

const formatAttachmentSize = (
  sizeBytes: number,
  format: ReturnType<typeof useFormatter>,
): string => {
  const size = getEmailAttachmentSize(sizeBytes);
  return format.number(size.value, {
    maximumFractionDigits: 1,
    style: "unit",
    unit: size.unit,
    unitDisplay: "short",
  });
};

const EmailParticipantRow = ({
  label,
  values,
}: {
  label: string;
  values: readonly string[];
}) => {
  if (values.length === 0) {
    return null;
  }
  const valueOccurrences = new Map<string, number>();

  return (
    <div className="text-muted-foreground grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3">
      <dt>{label}</dt>
      <dd className="min-w-0 text-start break-words">
        {values.map((value, index) => (
          <Fragment key={getOccurrenceKey(value, valueOccurrences)}>
            {index > 0 ? ", " : null}
            <BidiText>{value}</BidiText>
          </Fragment>
        ))}
      </dd>
    </div>
  );
};

const getAttachmentKey = (
  attachment: {
    fileName: string | null;
    mimeType: string | null;
    sizeBytes: number;
  },
  occurrences: Map<string, number>,
): string => {
  const signature = JSON.stringify([
    attachment.fileName,
    attachment.mimeType,
    attachment.sizeBytes,
  ]);
  return getOccurrenceKey(signature, occurrences);
};

const getOccurrenceKey = (
  value: string,
  occurrences: Map<string, number>,
): string => {
  const occurrence = occurrences.get(value) ?? 0;
  occurrences.set(value, occurrence + 1);
  return `${value}:${occurrence}`;
};
