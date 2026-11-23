import { useId } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  type MailboxMessage,
  mailboxMessageDetails,
} from "@stll/api-contract/mailbox";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { formatFileSize } from "@stll/ui/file-size";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { DocumentIcon } from "@/components/document-icon";
import {
  FilePartViewer,
  PartDownloadButton,
  PartSaveControls,
  useOpenFilePart,
} from "@/components/file-parts/file-parts";
import { FILE_PART_UNAVAILABLE_LABEL } from "@/components/file-parts/file-parts.logic";
import {
  type FilePartActions,
  useFilePartActions,
} from "@/components/file-parts/use-file-part-actions";
import type { FileTab } from "@/components/inspector/file-tab";
import { useFormatter } from "@/i18n/formatting-context";
import { mailboxPreviewOptions } from "@/lib/files/legal-file-queries";

const MESSAGE_DATE_FORMAT = {
  dateStyle: "medium",
  timeStyle: "short",
} as const satisfies Intl.DateTimeFormatOptions;

/** One message as its row shows it: its subject, then who, when and where. */
const MessageRow = ({
  actions,
  message,
  onOpen,
}: {
  actions: FilePartActions;
  message: MailboxMessage;
  onOpen: (part: string) => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const nameId = useId();
  const subject = message.subject ?? t("emailViewer.noSubject");
  const details = [
    ...mailboxMessageDetails(message, (date) =>
      format.dateTime(date, MESSAGE_DATE_FORMAT),
    ),
    ...(message.unavailable === null
      ? []
      : [t(FILE_PART_UNAVAILABLE_LABEL[message.unavailable])]),
  ].join(" · ");
  const size = (
    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
      {formatFileSize(message.sizeBytes, format)}
    </span>
  );
  const text = (
    <span className="min-w-0 flex-1">
      <TruncatedText
        className={cn(
          "block text-sm",
          message.part !== null && "font-medium",
          message.subject === null && "text-muted-foreground",
        )}
        id={nameId}
        render={<BidiText as="span" />}
      >
        {subject}
      </TruncatedText>
      {details ? (
        <TruncatedText
          className="text-muted-foreground block text-xs"
          lines={2}
          render={<BidiText as="span" />}
        >
          {details}
        </TruncatedText>
      ) : null}
    </span>
  );
  const { part } = message;
  if (part === null) {
    return (
      <li className="text-muted-foreground flex min-h-12 items-center gap-3 px-3 py-2">
        <DocumentIcon
          className="size-5 shrink-0"
          fileName={message.fileName}
          mimeType={null}
        />
        {text}
        {size}
      </li>
    );
  }
  return (
    <li className="flex min-h-12 items-center gap-1 pe-2">
      <Button
        aria-label={t("inspector.fileParts.open", { fileName: subject })}
        className="flex min-h-12 min-w-0 flex-1"
        onClick={() => onOpen(part.part)}
        variant="plain"
      >
        <span className="hover:bg-muted/60 flex min-h-12 w-full min-w-0 items-center gap-3 rounded-s-lg px-3 py-2 text-start">
          <DocumentIcon
            className="size-5 shrink-0"
            fileName={part.fileName}
            mimeType={part.mediaType}
          />
          {text}
          {size}
        </span>
      </Button>
      <PartDownloadButton
        actions={actions}
        compact
        fileName={part.fileName ?? subject}
        part={part.part}
      />
      {actions.canSave ? (
        <PartSaveControls
          actions={actions}
          compact
          descriptionId={nameId}
          part={part.part}
        />
      ) : null}
    </li>
  );
};

/**
 * A mailbox: its messages in the order it stores them, each with its
 * subject, sender, date and folder, opening in place in the email viewer; a
 * message that does not open (too large, damaged) is listed with the reason.
 * The list is read from the messages' headers; no body is read until a
 * message is opened.
 */
export const MailboxViewer = ({
  onDownload,
  tab,
}: {
  onDownload: () => void;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    mailboxPreviewOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
  );
  const t = useTranslations();
  const titleId = useId();
  const source = { fieldId: tab.id, workspaceId: tab.workspaceId };
  const actions = useFilePartActions(source);
  const parts = data.messages.flatMap((message) =>
    message.part === null ? [] : [{ ...message.part, detail: message.folder }],
  );
  const { open, openPart, close } = useOpenFilePart(parts);

  return (
    <FileViewerWithAI
      activeFile={{
        entityId: tab.entityId,
        fileFieldId: tab.id,
        fileName: tab.fileName,
      }}
      className="flex h-full min-h-0 flex-col"
      workspaceId={tab.workspaceId}
    >
      {open === null ? null : (
        <FilePartViewer
          actions={actions}
          key={open.part}
          onBack={close}
          row={open}
          source={source}
        />
      )}
      <ScrollArea
        axis="vertical"
        className={cn("min-h-0 flex-1", open !== null && "hidden")}
      >
        <article className="space-y-4 p-4" {...DOCKED_COMPOSER_CLEARANCE}>
          <Button
            onClick={onDownload}
            size="sm"
            type="button"
            variant="outline"
          >
            <DownloadIcon />
            {t("common.downloadOriginal")}
          </Button>
          {data.messages.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("inspector.mailbox.noMessages")}
            </p>
          ) : (
            <section aria-labelledby={titleId} className="space-y-2">
              <h2 className="text-sm font-medium" id={titleId}>
                {t("inspector.mailbox.messages")}
              </h2>
              {data.truncated ? (
                <p className="text-muted-foreground text-xs">
                  {t("inspector.mailbox.truncated", {
                    count: data.messages.length,
                  })}
                </p>
              ) : null}
              <ul className="divide-y rounded-lg border">
                {data.messages.map((message, position) => (
                  <MessageRow
                    actions={actions}
                    key={
                      message.part?.part ?? `unavailable:${String(position)}`
                    }
                    message={message}
                    onOpen={openPart}
                  />
                ))}
              </ul>
            </section>
          )}
        </article>
      </ScrollArea>
      {actions.dialog}
    </FileViewerWithAI>
  );
};
