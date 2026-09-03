import { Fragment, useRef, useState, type ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, PaperclipIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  EMAIL_HEADER_CITATION_ID,
  type EmailHeaderCitationId,
} from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { FILE_CHAT_OVERLAY_ACTIVATION } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import { DocumentIcon } from "@/components/document-icon";
import { getEmailAttachmentActivationId } from "@/components/inspector/email-attachments-facet.logic";
import {
  EMAIL_CHAT_HOST,
  EMAIL_CHAT_MODE,
  EMAIL_VIEWER_LAYOUT,
  getEmailBodyFrameHeight,
  getEmailFileChatContext,
  localizeEmailBodyHtml,
  parseEmailDate,
  type EmailBodyFoldLabels,
  type EmailChatHost,
  type EmailChatMode,
  type EmailResolvedChatMode,
  type EmailViewerLayout,
} from "@/components/inspector/email-html-viewer.logic";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { getFileSizeDisplay } from "@/lib/file-size";
import {
  EMAIL_CITATION_SCROLL_EVENT,
  isEmailCitationTargetDetail,
  isKnownEmailCitationTarget,
  registerEmailCitationBlocks,
} from "@/lib/files/email-citations";
import { EMAIL_BODY_FOLD_KIND } from "@/lib/files/email-preview";
import { emailHtmlPreviewOptions } from "@/lib/files/queries";
import { formatFullTimestamp } from "@/lib/relative-time";

type EmailHtmlViewerProps = {
  entityId: string;
  fieldId: string;
  layout?: EmailViewerLayout;
  onOpenAttachment: (attachmentId: string | null) => void;
  workspaceId: string;
};

type EmailFileViewerBaseProps = EmailHtmlViewerProps & {
  entityId: string;
  fileName: string;
  overlayActivation?: (typeof FILE_CHAT_OVERLAY_ACTIVATION)[keyof typeof FILE_CHAT_OVERLAY_ACTIVATION];
  chatHost?: EmailChatHost;
};

type EmailFileViewerProps = EmailFileViewerBaseProps &
  (
    | {
        chatMode: EmailResolvedChatMode;
      }
    | {
        chatMode: typeof EMAIL_CHAT_MODE.resolutionError;
        onRetryChatResolution: () => void;
      }
  );

export const EmailFileViewer = (props: EmailFileViewerProps) => {
  const {
    chatMode,
    entityId,
    fieldId,
    fileName,
    onOpenAttachment,
    overlayActivation = FILE_CHAT_OVERLAY_ACTIVATION.active,
    chatHost = EMAIL_CHAT_HOST.self,
    workspaceId,
  } = props;
  const isContextual = chatMode === EMAIL_CHAT_MODE.contextual;
  const content = (
    <>
      <EmailHtmlViewer
        entityId={entityId}
        fieldId={fieldId}
        layout={
          isContextual
            ? EMAIL_VIEWER_LAYOUT.contextualChat
            : EMAIL_VIEWER_LAYOUT.standard
        }
        onOpenAttachment={onOpenAttachment}
        workspaceId={workspaceId}
      />
      {chatMode === EMAIL_CHAT_MODE.resolutionError ? (
        <EmailChatResolutionAlert onRetry={props.onRetryChatResolution} />
      ) : null}
    </>
  );

  if (chatHost === EMAIL_CHAT_HOST.parent) {
    return content;
  }

  return (
    <EmailViewerWithAI
      chatMode={chatMode}
      entityId={entityId}
      fieldId={fieldId}
      fileName={fileName}
      overlayActivation={overlayActivation}
      workspaceId={workspaceId}
    >
      {content}
    </EmailViewerWithAI>
  );
};

export const EmailChatResolutionAlert = ({
  onRetry,
}: {
  onRetry: () => void;
}) => {
  const t = useTranslations();
  return (
    <div
      className="bg-background flex shrink-0 items-center justify-center gap-2 border-t p-2"
      role="alert"
    >
      <span className="text-muted-foreground text-sm">
        {t("common.somethingWentWrong")}
      </span>
      <Button onClick={onRetry} size="sm" variant="outline">
        {t("common.tryAgain")}
      </Button>
    </div>
  );
};

export const EmailViewerWithAI = ({
  chatMode,
  children,
  entityId,
  fieldId,
  fileName,
  overlayActivation,
  workspaceId,
}: {
  chatMode: EmailChatMode;
  children: ReactNode;
  entityId: string;
  fieldId: string;
  fileName: string;
  overlayActivation: (typeof FILE_CHAT_OVERLAY_ACTIVATION)[keyof typeof FILE_CHAT_OVERLAY_ACTIVATION];
  workspaceId: string;
}) => {
  const isContextual = chatMode === EMAIL_CHAT_MODE.contextual;
  const fileChatContext = isContextual
    ? getEmailFileChatContext({
        entityId,
        fieldId,
        fileName,
        workspaceId,
      })
    : { activeFile: undefined, workspaceId };

  return (
    <FileViewerWithAI
      {...fileChatContext}
      className="flex min-h-0 flex-1 flex-col"
      overlayActivation={
        isContextual ? overlayActivation : FILE_CHAT_OVERLAY_ACTIVATION.deferred
      }
    >
      {children}
    </FileViewerWithAI>
  );
};

export const EmailHtmlViewer = ({
  entityId,
  fieldId,
  layout = EMAIL_VIEWER_LAYOUT.standard,
  onOpenAttachment,
  workspaceId,
}: EmailHtmlViewerProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const articleRef = useRef<HTMLElement>(null);
  const bodyFrameRef = useRef<HTMLIFrameElement>(null);
  const bodyResizeObserverRef = useRef<ResizeObserver | null>(null);
  const [activeCitationBlockId, setActiveCitationBlockId] = useState<
    string | null
  >(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const previewQuery = useQuery(
    emailHtmlPreviewOptions({ workspaceId, fieldId }),
  );

  useMountEffect(() => () => {
    bodyResizeObserverRef.current?.disconnect();
  });

  useExternalSyncEffect(() => {
    if (!previewQuery.data) {
      return undefined;
    }
    return registerEmailCitationBlocks({
      blockIds: previewQuery.data.citationBlocks.map(({ id }) => id),
      entityId,
      fieldId,
    });
  }, [entityId, fieldId, previewQuery.data]);

  useExternalSyncEffect(() => {
    const handleCitation = (event: Event): void => {
      if (!("detail" in event) || !isEmailCitationTargetDetail(event.detail)) {
        return;
      }
      const { detail } = event;
      if (
        detail.entityId !== entityId ||
        detail.fieldId !== fieldId ||
        !isKnownEmailCitationTarget(detail)
      ) {
        return;
      }
      setActiveCitationBlockId(detail.blockId);
      scrollToEmailCitation({
        article: articleRef.current,
        blockId: detail.blockId,
        bodyFrame: bodyFrameRef.current,
      });
    };
    window.addEventListener(EMAIL_CITATION_SCROLL_EVENT, handleCitation);
    return () => {
      window.removeEventListener(EMAIL_CITATION_SCROLL_EVENT, handleCitation);
    };
  }, [entityId, fieldId]);

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
            detached(previewQuery.refetch(), "email-html-viewer.refetch");
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
    <article
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain",
        layout === EMAIL_VIEWER_LAYOUT.contextualChat && "pb-40",
      )}
      ref={articleRef}
    >
      <header className="bg-background shrink-0 border-b px-4 py-3">
        <h1
          className={cn(
            "text-foreground text-base font-semibold text-balance",
            activeCitationBlockId === EMAIL_HEADER_CITATION_ID.subject &&
              "bg-highlight text-highlight-foreground ring-highlight-foreground/30 ring-2 ring-offset-2",
          )}
          data-stella-email-anchor={EMAIL_HEADER_CITATION_ID.subject}
        >
          <BidiText as="span">{subject}</BidiText>
        </h1>
        <dl className="mt-3 grid min-w-0 gap-1.5 text-xs">
          <EmailParticipantRow
            activeCitationBlockId={activeCitationBlockId}
            citationBlockId={EMAIL_HEADER_CITATION_ID.from}
            label={t("emailViewer.from")}
            values={preview.from ? [preview.from] : []}
          />
          <EmailParticipantRow
            activeCitationBlockId={activeCitationBlockId}
            citationBlockId={EMAIL_HEADER_CITATION_ID.to}
            label={t("emailViewer.to")}
            values={preview.to}
          />
          {formattedDate ? (
            <div
              className={cn(
                "text-muted-foreground grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3",
                activeCitationBlockId === EMAIL_HEADER_CITATION_ID.date &&
                  "bg-highlight text-highlight-foreground ring-highlight-foreground/30 ring-2 ring-offset-2",
              )}
              data-stella-email-anchor={EMAIL_HEADER_CITATION_ID.date}
            >
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
                activeCitationBlockId={activeCitationBlockId}
                citationBlockId={EMAIL_HEADER_CITATION_ID.cc}
                label={t("emailViewer.cc")}
                values={preview.cc}
              />
              <EmailParticipantRow
                activeCitationBlockId={activeCitationBlockId}
                citationBlockId={EMAIL_HEADER_CITATION_ID.bcc}
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
                  key={getAttachmentKey(attachment, attachmentKeyOccurrences)}
                >
                  <button
                    className="bg-muted/50 hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs focus-visible:ring-2 focus-visible:outline-none"
                    onClick={() => {
                      onOpenAttachment(
                        getEmailAttachmentActivationId(attachment),
                      );
                    }}
                    type="button"
                  >
                    <DocumentIcon
                      className="text-muted-foreground size-4 shrink-0"
                      fileName={
                        attachment.fileName ??
                        t("emailViewer.unnamedAttachment")
                      }
                      mimeType={
                        attachment.mimeType ?? "application/octet-stream"
                      }
                    />
                    <BidiText as="span" className="max-w-48 min-w-0 truncate">
                      {attachment.fileName ??
                        t("emailViewer.unnamedAttachment")}
                    </BidiText>
                    {attachment.sizeBytes > 0 ? (
                      <span className="text-muted-foreground shrink-0">
                        {formatAttachmentSize(attachment.sizeBytes, format)}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </header>
      <div className="bg-muted/30 min-w-0 shrink-0 p-2">
        <iframe
          className="bg-background w-full border-0"
          onLoad={(event) => {
            bodyResizeObserverRef.current?.disconnect();
            const frame = event.currentTarget;
            resizeEmailBodyFrame(frame);
            const bodyDocument = frame.contentDocument;
            if (bodyDocument) {
              const resizeObserver = new ResizeObserver(() => {
                resizeEmailBodyFrame(frame);
              });
              resizeObserver.observe(bodyDocument.documentElement);
              resizeObserver.observe(bodyDocument.body);
              bodyResizeObserverRef.current = resizeObserver;
            }
            if (!activeCitationBlockId) {
              return;
            }
            scrollToEmailCitation({
              article: articleRef.current,
              blockId: activeCitationBlockId,
              bodyFrame: bodyFrameRef.current,
            });
          }}
          ref={bodyFrameRef}
          referrerPolicy="no-referrer"
          sandbox="allow-same-origin"
          srcDoc={bodyHtml}
          style={{ height: 0 }}
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
  const size = getFileSizeDisplay(sizeBytes);
  return format.number(size.value, {
    maximumFractionDigits: 1,
    style: "unit",
    unit: size.unit,
    unitDisplay: "short",
  });
};

const EmailParticipantRow = ({
  activeCitationBlockId,
  citationBlockId,
  label,
  values,
}: {
  activeCitationBlockId: string | null;
  citationBlockId: EmailHeaderCitationId;
  label: string;
  values: readonly string[];
}) => {
  if (values.length === 0) {
    return null;
  }
  const valueOccurrences = new Map<string, number>();

  return (
    <div
      className={cn(
        "text-muted-foreground grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3",
        activeCitationBlockId === citationBlockId &&
          "bg-highlight text-highlight-foreground ring-highlight-foreground/30 ring-2 ring-offset-2",
      )}
      data-stella-email-anchor={citationBlockId}
    >
      <dt>{label}</dt>
      <dd className="min-w-0 text-start wrap-break-word">
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

const scrollToEmailCitation = ({
  article,
  blockId,
  bodyFrame,
}: {
  article: HTMLElement | null;
  blockId: string;
  bodyFrame: HTMLIFrameElement | null;
}): void => {
  const bodyDocument = bodyFrame?.contentDocument;
  if (bodyDocument) {
    for (const active of bodyDocument.querySelectorAll<HTMLElement>(
      "[data-stella-email-citation-active]",
    )) {
      delete active.dataset["stellaEmailCitationActive"];
    }
  }

  const headerTarget = findEmailCitationElement(article, blockId);
  if (headerTarget) {
    openAncestorDetails(headerTarget);
    headerTarget.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  if (!bodyDocument) {
    return;
  }
  const bodyTarget = findEmailCitationElement(bodyDocument.body, blockId);
  if (!bodyTarget) {
    return;
  }
  openAncestorDetails(bodyTarget);
  bodyTarget.dataset["stellaEmailCitationActive"] = "";
  resizeEmailBodyFrame(bodyFrame);
  const articleRect = article?.getBoundingClientRect();
  const frameRect = bodyFrame.getBoundingClientRect();
  const targetRect = bodyTarget.getBoundingClientRect();
  if (!article || !articleRect) {
    return;
  }
  const targetTop =
    article.scrollTop +
    frameRect.top -
    articleRect.top +
    targetRect.top -
    article.clientHeight / 2 +
    targetRect.height / 2;
  article.scrollTo({
    behavior: "smooth",
    top: Math.max(0, targetTop),
  });
};

const resizeEmailBodyFrame = (frame: HTMLIFrameElement | null): void => {
  const bodyDocument = frame?.contentDocument;
  const body = bodyDocument?.body;
  const documentElement = bodyDocument?.documentElement;
  if (!frame || !bodyDocument || !body || !documentElement) {
    return;
  }
  // Collapse the viewport before measuring so viewport-sized metrics cannot
  // preserve the previous height after quoted history or a signature closes.
  frame.style.height = "0px";
  const bodyStyle = bodyDocument.defaultView?.getComputedStyle(body);
  const marginBlockStart =
    Number.parseFloat(bodyStyle?.marginBlockStart ?? "0") || 0;
  const marginBlockEnd =
    Number.parseFloat(bodyStyle?.marginBlockEnd ?? "0") || 0;
  frame.style.height = `${getEmailBodyFrameHeight({
    body: {
      clientHeight: body.clientHeight,
      offsetHeight: body.offsetHeight,
      renderedHeight: body.getBoundingClientRect().height,
      scrollHeight: body.scrollHeight,
      scrollWidth: body.scrollWidth,
    },
    documentElement: {
      clientHeight: documentElement.clientHeight,
      offsetHeight: documentElement.offsetHeight,
      scrollHeight: documentElement.scrollHeight,
      scrollWidth: documentElement.scrollWidth,
    },
    marginBlockEnd,
    marginBlockStart,
  })}px`;
};

const openAncestorDetails = (target: HTMLElement): void => {
  let ancestor = target.parentElement;
  while (ancestor) {
    if (ancestor.tagName === "DETAILS") {
      ancestor.setAttribute("open", "");
    }
    ancestor = ancestor.parentElement;
  }
};

const findEmailCitationElement = (
  root: ParentNode | null,
  blockId: string,
): HTMLElement | null => {
  if (!root) {
    return null;
  }
  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-stella-email-anchor]",
  )) {
    if (element.dataset["stellaEmailAnchor"] === blockId) {
      return element;
    }
  }
  return null;
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
