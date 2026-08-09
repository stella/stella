import { useState, type ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, ArrowLeftIcon, PaperclipIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import { Skeleton } from "@stll/ui/components/skeleton";

import { DocumentIcon } from "@/components/document-icon";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import {
  emailAttachmentPdfOptions,
  emailAttachmentPreviewUrl,
  emailHtmlPreviewOptions,
} from "@/lib/files/queries";

type EmailAttachmentsFacetProps = {
  fieldId: string;
  workspaceId: string;
};

type AttachmentDescriptor = {
  id: string;
  fileName: string | null;
  mimeType: string | null;
  previewable: boolean;
};

export const EmailAttachmentsFacet = ({
  fieldId,
  workspaceId,
}: EmailAttachmentsFacetProps) => {
  const t = useTranslations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const previewQuery = useQuery(
    emailHtmlPreviewOptions({ fieldId, workspaceId }),
  );

  if (previewQuery.isPending) {
    return <Skeleton className="m-3 h-24 rounded-sm" />;
  }
  if (previewQuery.isError) {
    return (
      <FacetMessage
        icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
        message={t("common.somethingWentWrong")}
      />
    );
  }

  const selected = previewQuery.data.attachments.find(
    ({ id }) => id === selectedId,
  );
  if (selectedId !== null && selected === undefined) {
    return (
      <FacetMessage
        icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
        message={t("common.somethingWentWrong")}
      />
    );
  }
  if (selected !== undefined) {
    return (
      <AttachmentPreview
        attachment={selected}
        fieldId={fieldId}
        onBack={() => setSelectedId(null)}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <AttachmentList
      attachments={previewQuery.data.attachments}
      fieldId={fieldId}
      onSelect={setSelectedId}
    />
  );
};

const AttachmentPreview = ({
  attachment,
  fieldId,
  onBack,
  workspaceId,
}: {
  attachment: AttachmentDescriptor;
  fieldId: string;
  onBack: () => void;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const fileName = attachment.fileName ?? t("emailViewer.unnamedAttachment");
  const isPdf =
    attachment.mimeType?.split(";").at(0)?.trim().toLowerCase() ===
    "application/pdf";
  const pdfQuery = useQuery(
    emailAttachmentPdfOptions({
      attachmentId: isPdf ? attachment.id : "",
      fieldId,
      workspaceId,
    }),
  );
  const [pdfObjectUrl, setPdfObjectUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageAttempt, setImageAttempt] = useState(0);

  useExternalSyncEffect(() => {
    if (!pdfQuery.data) {
      setPdfObjectUrl(null);
      return undefined;
    }
    const objectUrl = URL.createObjectURL(
      new Blob([pdfQuery.data], { type: "application/pdf" }),
    );
    setPdfObjectUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [pdfQuery.data]);

  const previewUrl = emailAttachmentPreviewUrl({
    attachmentId: attachment.id,
    fieldId,
    workspaceId,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button
          aria-label={t("common.back")}
          onClick={onBack}
          size="icon-xs"
          variant="ghost"
        >
          <DirectionalIcon className="size-3.5" icon={ArrowLeftIcon} />
        </Button>
        <BidiText as="span" className="min-w-0 truncate text-sm font-medium">
          {fileName}
        </BidiText>
      </div>
      <div className="bg-muted/30 flex min-h-0 flex-1 items-center justify-center p-2">
        <AttachmentPreviewContent
          fileName={fileName}
          imageAttempt={imageAttempt}
          imageFailed={imageFailed}
          mimeType={attachment.mimeType}
          onImageError={() => setImageFailed(true)}
          onRetryImage={() => {
            setImageFailed(false);
            setImageAttempt((attempt) => attempt + 1);
          }}
          previewUrl={isPdf ? pdfObjectUrl : previewUrl}
          previewError={pdfQuery.isError}
        />
      </div>
    </div>
  );
};

const AttachmentPreviewContent = ({
  fileName,
  imageFailed,
  imageAttempt,
  mimeType,
  onImageError,
  onRetryImage,
  previewUrl,
  previewError,
}: {
  fileName: string;
  imageFailed: boolean;
  imageAttempt: number;
  mimeType: string | null;
  onImageError: () => void;
  onRetryImage: () => void;
  previewUrl: string | null;
  previewError: boolean;
}) => {
  const t = useTranslations();
  if (previewError) {
    return (
      <FacetMessage
        icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
        message={t("common.somethingWentWrong")}
      />
    );
  }
  if (imageFailed) {
    return (
      <FacetMessage
        action={
          <Button onClick={onRetryImage} size="sm" variant="outline">
            {t("common.tryAgain")}
          </Button>
        }
        icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
        message={t("common.somethingWentWrong")}
      />
    );
  }
  if (previewUrl === null) {
    return <Skeleton className="size-full rounded-sm" />;
  }
  if (mimeType?.toLowerCase().startsWith("image/") === true) {
    return (
      <img
        alt={fileName}
        className="max-h-full max-w-full object-contain"
        key={imageAttempt}
        onError={onImageError}
        referrerPolicy="no-referrer"
        src={previewUrl}
      />
    );
  }

  return (
    <iframe
      className="bg-background size-full border-0"
      referrerPolicy="no-referrer"
      sandbox=""
      src={previewUrl}
      title={t("emailViewer.bodyTitle")}
    />
  );
};

const AttachmentList = ({
  attachments,
  fieldId,
  onSelect,
}: {
  attachments: readonly AttachmentDescriptor[];
  fieldId: string;
  onSelect: (id: string) => void;
}) => {
  const t = useTranslations();

  return (
    <section
      aria-labelledby={`${fieldId}-attachment-facet`}
      className="min-h-0 flex-1 overflow-y-auto p-3"
    >
      <h2
        className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium"
        id={`${fieldId}-attachment-facet`}
      >
        <PaperclipIcon aria-hidden="true" className="size-3.5" />
        {t("emailViewer.attachments")}
      </h2>
      {attachments.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("common.noResults")}</p>
      ) : (
        <ul className="grid gap-1.5">
          {attachments.map((attachment) => (
            <AttachmentListItem
              attachment={attachment}
              key={attachment.id}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

const AttachmentListItem = ({
  attachment,
  onSelect,
}: {
  attachment: AttachmentDescriptor;
  onSelect: (id: string) => void;
}) => {
  const t = useTranslations();
  const fileName = attachment.fileName ?? t("emailViewer.unnamedAttachment");
  const unsupportedLabel = t("chat.unsupportedFileType");

  return (
    <li>
      <button
        className="hover:bg-muted/60 flex min-h-11 w-full items-center gap-2 rounded-md border px-2 text-start text-xs"
        disabled={!attachment.previewable}
        onClick={() => onSelect(attachment.id)}
        type="button"
      >
        <DocumentIcon
          className="text-muted-foreground size-4 shrink-0"
          fileName={fileName}
          mimeType={attachment.mimeType ?? "application/octet-stream"}
        />
        <BidiText as="span" className="min-w-0 flex-1 truncate">
          {fileName}
        </BidiText>
        {!attachment.previewable ? (
          <span className="text-muted-foreground shrink-0">
            {unsupportedLabel}
          </span>
        ) : null}
      </button>
    </li>
  );
};

const FacetMessage = ({
  action,
  icon,
  message,
}: {
  action?: ReactNode;
  icon: ReactNode;
  message: string;
}) => (
  <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
    {icon}
    <p>{message}</p>
    {action}
  </div>
);
