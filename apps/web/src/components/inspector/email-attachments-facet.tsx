import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, ArrowLeftIcon, PaperclipIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { Skeleton } from "@stll/ui/components/skeleton";

import { DocumentIcon } from "@/components/document-icon";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { emailAttachmentPreviewOptions, emailHtmlPreviewOptions } from "@/lib/files/queries";

type EmailAttachmentsFacetProps = {
  fieldId: string;
  workspaceId: string;
};

export const EmailAttachmentsFacet = ({
  fieldId,
  workspaceId,
}: EmailAttachmentsFacetProps) => {
  const t = useTranslations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const previewQuery = useQuery(emailHtmlPreviewOptions({ fieldId, workspaceId }));
  const selected = previewQuery.data?.attachments.find(({ id }) => id === selectedId);
  const attachmentQuery = useQuery(
    emailAttachmentPreviewOptions({
      attachmentId: selected?.id ?? "",
      fieldId,
      workspaceId,
    }),
  );
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useExternalSyncEffect(() => {
    if (!attachmentQuery.data) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([attachmentQuery.data.buffer], {
        type: attachmentQuery.data.mimeType,
      }),
    );
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [attachmentQuery.data]);

  if (previewQuery.isPending) {
    return <Skeleton className="m-3 h-24 rounded-sm" />;
  }
  if (previewQuery.isError) {
    return <FacetMessage icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />} message={t("common.somethingWentWrong")} />;
  }
  if (selected) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
          <Button
            aria-label={t("common.back")}
            onClick={() => setSelectedId(null)}
            size="icon-xs"
            variant="ghost"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          </Button>
          <BidiText as="span" className="min-w-0 truncate text-sm font-medium">
            {selected.fileName ?? t("emailViewer.unnamedAttachment")}
          </BidiText>
        </div>
        <div className="bg-muted/30 flex min-h-0 flex-1 items-center justify-center p-2">
          {attachmentQuery.isPending ? <Skeleton className="size-full rounded-sm" /> : null}
          {attachmentQuery.isError ? (
            <FacetMessage
              icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
              message={t("common.somethingWentWrong")}
            />
          ) : null}
          {objectUrl ? (
            selected.mimeType?.toLowerCase().startsWith("image/") ? (
              <img
                alt={selected.fileName ?? t("emailViewer.unnamedAttachment")}
                className="max-h-full max-w-full object-contain"
                src={objectUrl}
              />
            ) : (
              <iframe
                className="bg-background size-full border-0"
                referrerPolicy="no-referrer"
                sandbox=""
                src={objectUrl}
                title={selected.fileName ?? t("emailViewer.unnamedAttachment")}
              />
            )
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby={`${fieldId}-attachment-facet`} className="min-h-0 flex-1 overflow-y-auto p-3">
      <h2 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium" id={`${fieldId}-attachment-facet`}>
        <PaperclipIcon aria-hidden="true" className="size-3.5" />
        {t("emailViewer.attachments")}
      </h2>
      {previewQuery.data.attachments.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("common.noResults")}</p>
      ) : (
        <ul className="grid gap-1.5">
          {previewQuery.data.attachments.map((attachment) => (
            <li key={attachment.id}>
              <button
                className="hover:bg-muted/60 flex min-h-11 w-full items-center gap-2 rounded-md border px-2 text-start text-xs"
                disabled={!attachment.previewable}
                onClick={() => setSelectedId(attachment.id)}
                type="button"
              >
                <DocumentIcon
                  className="text-muted-foreground size-4 shrink-0"
                  fileName={attachment.fileName ?? t("emailViewer.unnamedAttachment")}
                  mimeType={attachment.mimeType ?? "application/octet-stream"}
                />
                <BidiText as="span" className="min-w-0 flex-1 truncate">
                  {attachment.fileName ?? t("emailViewer.unnamedAttachment")}
                </BidiText>
                {!attachment.previewable ? (
                  <span className="text-muted-foreground shrink-0">{t("chat.unsupportedFileType")}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const FacetMessage = ({
  icon,
  message,
}: {
  icon: ReactNode;
  message: string;
}) => (
  <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
    {icon}
    <p>{message}</p>
  </div>
);
