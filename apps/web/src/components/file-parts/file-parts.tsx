import { lazy, type ReactNode, Suspense, useId, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { EmailTextAttachmentCharset } from "@stll/api-contract";
import type { FilePartDescriptor } from "@stll/api-contract/file-parts";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { formatFileSize } from "@stll/ui/file-size";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  DownloadIcon,
  SaveIcon,
} from "@stll/ui/icons";
import { MenuItem, MenuPopup } from "@stll/ui/menu";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { SplitButton } from "@stll/ui/split-button";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { DocumentIcon } from "@/components/document-icon";
import {
  decodeFilePartText,
  FILE_PART_PREVIEW_KIND,
  type FilePartPreviewKind,
  filePartPreviewKind,
  filePartViewId,
  isFilePartPdfPreviewKind,
} from "@/components/file-parts/file-parts.logic";
import type { FilePartActions } from "@/components/file-parts/use-file-part-actions";
import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import type { ZoomDirection } from "@/components/inspector/zoom-controls";
import { PeekPdfControls } from "@/components/pdf/peek/peek-pdf-viewer";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { filePartContentOptions } from "@/lib/files/file-part-queries";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import {
  getPDFScaleOffset,
  PDF_SCALE_OFFSET_STEP,
} from "@/lib/pdf/pdf-zoom.logic";

// A Word part draws in the read-only document view, a spreadsheet or a
// presentation in the office canvas: the views a stored file of the type
// opens in. Both load with the first such part opened.
const ReadOnlyDocxDocument = lazy(async () => {
  const m = await import("@/components/docx/read-only-docx-document");
  return { default: m.ReadOnlyDocxDocument };
});

const OfficeDocumentCanvas = lazy(async () => {
  const m = await import("@/components/office/office-document-canvas");
  return { default: m.OfficeDocumentCanvas };
});

/** Kinds whose preview zooms with the header's controls. */
const isZoomablePreviewKind = (kind: FilePartPreviewKind) =>
  isFilePartPdfPreviewKind(kind) || kind === FILE_PART_PREVIEW_KIND.docx;

/** A part as a list shows it; a container may add one line under its name. */
export type FilePartRow = FilePartDescriptor & {
  /** A further line, such as an invoice's description of its attachment. */
  detail?: string | null;
  /** The text encoding the container declares for a text part. */
  charset?: EmailTextAttachmentCharset | null;
};

type FilePartSource = { fieldId: string; workspaceId: string };

const usePartName = () => {
  const t = useTranslations();
  return (part: Pick<FilePartDescriptor, "fileName">) =>
    part.fileName ?? t("emailViewer.unnamedAttachment");
};

const PartSaveControls = ({
  actions,
  compact,
  descriptionId,
  part,
}: {
  actions: FilePartActions;
  compact: boolean;
  descriptionId: string;
  part: string;
}) => {
  const t = useTranslations();
  return (
    <SplitButton
      menuDescriptionId={descriptionId}
      menuDisabled={actions.saving}
      menuLabel={t("common.selectAMatter")}
      onPrimaryClick={() => actions.saveHere(part)}
      primaryContent={compact ? "icon" : "text"}
      primaryDescriptionId={descriptionId}
      primaryDisabledReason={actions.saving ? t("common.saving") : undefined}
      primaryLabel={t("common.save")}
      size="sm"
      menu={
        <MenuPopup align="end">
          <MenuItem onClick={() => actions.chooseMatter(part)}>
            {t("common.selectAMatter")}
          </MenuItem>
        </MenuPopup>
      }
    >
      <SaveIcon aria-hidden="true" className="size-3.5" />
      {compact ? null : t("common.save")}
    </SplitButton>
  );
};

const PartDownloadButton = ({
  actions,
  compact,
  fileName,
  part,
}: {
  actions: FilePartActions;
  compact: boolean;
  fileName: string;
  part: string;
}) => {
  const t = useTranslations();
  return (
    <Button
      aria-label={t("inspector.fileParts.download", { fileName })}
      loading={actions.isDownloading(part)}
      onClick={() => actions.download(part)}
      size={compact ? "icon-sm" : "sm"}
      type="button"
      variant={compact ? "ghost" : "outline"}
    >
      <DownloadIcon aria-hidden="true" className="size-3.5" />
      {compact ? null : t("common.download")}
    </Button>
  );
};

/**
 * The files inside a file (an email's attachments, a data-box message's
 * files, a signed container's documents, an invoice's attachments), one row
 * each: the type icon, name and size open the part in place; download and
 * save to a matter sit at the row's end.
 */
export const FilePartList = ({
  actions,
  onOpen,
  parts,
  title,
}: {
  actions: FilePartActions;
  onOpen: (part: string) => void;
  parts: readonly FilePartRow[];
  title: string;
}) => {
  const titleId = useId();
  if (parts.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h2 className="text-sm font-medium" id={titleId}>
        {title}
      </h2>
      <ul className="divide-y rounded-lg border">
        {parts.map((row) => (
          <FilePartListItem
            actions={actions}
            key={row.part}
            onOpen={onOpen}
            row={row}
          />
        ))}
      </ul>
    </section>
  );
};

const FilePartListItem = ({
  actions,
  onOpen,
  row,
}: {
  actions: FilePartActions;
  onOpen: (part: string) => void;
  row: FilePartRow;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const nameOf = usePartName();
  const nameId = useId();
  const fileName = nameOf(row);
  return (
    <li className="flex min-h-12 items-center gap-1 pe-2">
      <Button
        aria-label={t("inspector.fileParts.open", { fileName })}
        className="flex min-h-12 min-w-0 flex-1"
        onClick={() => onOpen(row.part)}
        variant="plain"
      >
        <span className="hover:bg-muted/60 flex min-h-12 w-full min-w-0 items-center gap-3 rounded-s-lg px-3 py-2 text-start">
          <DocumentIcon
            className="size-5 shrink-0"
            fileName={fileName}
            mimeType={row.mediaType}
          />
          <span className="min-w-0 flex-1">
            <TruncatedText
              className="block text-sm font-medium"
              id={nameId}
              render={<BidiText as="span" />}
            >
              {fileName}
            </TruncatedText>
            {row.detail ? (
              <TruncatedText
                className="text-muted-foreground block text-xs"
                lines={2}
                render={<BidiText as="span" />}
              >
                {row.detail}
              </TruncatedText>
            ) : null}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {formatFileSize(row.sizeBytes, format)}
          </span>
        </span>
      </Button>
      <PartDownloadButton
        actions={actions}
        compact
        fileName={fileName}
        part={row.part}
      />
      {actions.canSave ? (
        <PartSaveControls
          actions={actions}
          compact
          descriptionId={nameId}
          part={row.part}
        />
      ) : null}
    </li>
  );
};

type ZoomControl = {
  onResetZoom: () => void;
  onZoom: (direction: ZoomDirection) => void;
  scaleOffset: number;
};

/** Zoom kept by the viewer itself, for hosts that do not keep it per tab. */
const useLocalZoom = (): ZoomControl => {
  const [scaleOffset, setScaleOffset] = useState(0);
  return {
    scaleOffset,
    onResetZoom: () => setScaleOffset(0),
    onZoom: (direction) =>
      setScaleOffset((current) =>
        getPDFScaleOffset(
          current,
          direction === "in" ? PDF_SCALE_OFFSET_STEP : -PDF_SCALE_OFFSET_STEP,
        ),
      ),
  };
};

/**
 * One part opened in place, with the way back to its container: a PDF in
 * the PDF viewer, an image, or text; any other type shows what it is, with
 * download and save. `fallback` is shown under that notice, such as the text
 * the server read from the part.
 */
export const FilePartViewer = ({
  actions,
  bottomClearance = false,
  fallback,
  onBack,
  row,
  source,
  zoom,
}: {
  actions: FilePartActions;
  /** Room for a docked composer under the preview. */
  bottomClearance?: boolean;
  fallback?: ReactNode;
  onBack: () => void;
  row: FilePartRow;
  source: FilePartSource;
  zoom?: ZoomControl;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const nameOf = usePartName();
  const nameId = useId();
  const localZoom = useLocalZoom();
  const { scaleOffset, onResetZoom, onZoom } = zoom ?? localZoom;
  const fileName = nameOf(row);
  const kind = filePartPreviewKind(row.mediaType);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button
          aria-label={t("inspector.fileParts.back")}
          onClick={onBack}
          size="icon-xs"
          variant="ghost"
        >
          <DirectionalIcon className="size-3.5" icon={ArrowLeftIcon} />
        </Button>
        <DocumentIcon
          className="size-4 shrink-0"
          fileName={fileName}
          mimeType={row.mediaType}
        />
        <TruncatedText
          className="min-w-0 flex-1 text-sm font-medium"
          id={nameId}
          render={<BidiText as="span" />}
        >
          {fileName}
        </TruncatedText>
        <span className="text-muted-foreground hidden shrink-0 text-xs tabular-nums sm:inline">
          {formatFileSize(row.sizeBytes, format)}
        </span>
        {isZoomablePreviewKind(kind) ? (
          <div className="flex shrink-0 items-center gap-1">
            <PeekPdfControls
              onReset={onResetZoom}
              onZoom={onZoom}
              scaleOffset={scaleOffset}
            />
          </div>
        ) : null}
        <PartDownloadButton
          actions={actions}
          compact
          fileName={fileName}
          part={row.part}
        />
        {actions.canSave ? (
          <PartSaveControls
            actions={actions}
            compact={false}
            descriptionId={nameId}
            part={row.part}
          />
        ) : null}
      </div>
      <div
        className={cn(
          "bg-muted/30 flex min-h-0 flex-1 flex-col p-2",
          bottomClearance && "pb-40",
        )}
      >
        {kind === FILE_PART_PREVIEW_KIND.none ? (
          <NoPreview
            actions={actions}
            fallback={fallback}
            fileName={fileName}
            row={row}
          />
        ) : (
          <FilePartPreview
            fileName={fileName}
            kind={kind}
            notConverted={
              <NoPreview
                actions={actions}
                fallback={fallback}
                fileName={fileName}
                message={t("inspector.fileParts.notConverted")}
                row={row}
              />
            }
            row={row}
            scaleOffset={scaleOffset}
            source={source}
          />
        )}
      </div>
    </div>
  );
};

const NoPreview = ({
  actions,
  fallback,
  fileName,
  message,
  row,
}: {
  actions: FilePartActions;
  fallback: ReactNode;
  fileName: string;
  /** Why there is no preview; by default, that the type has none. */
  message?: string;
  row: FilePartRow;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col rounded-sm">
      <ScrollArea axis="vertical" className="min-h-0 flex-1">
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <DocumentIcon
            className="size-10"
            fileName={fileName}
            mimeType={row.mediaType}
          />
          <div className="space-y-1">
            <BidiText as="p" className="text-sm font-medium wrap-break-word">
              {fileName}
            </BidiText>
            <p className="text-muted-foreground text-xs tabular-nums">
              {formatFileSize(row.sizeBytes, format)}
            </p>
          </div>
          <p className="text-muted-foreground max-w-sm text-sm text-pretty">
            {message ?? t("inspector.fileParts.noPreview")}
          </p>
          <PartDownloadButton
            actions={actions}
            compact={false}
            fileName={fileName}
            part={row.part}
          />
        </div>
        {fallback === null || fallback === undefined ? null : (
          <div className="border-t p-4">{fallback}</div>
        )}
      </ScrollArea>
    </div>
  );
};

const PreviewMessage = ({
  action,
  message,
}: {
  action?: ReactNode;
  message: string;
}) => (
  <div
    className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm"
    role="alert"
  >
    <AlertTriangleIcon aria-hidden="true" className="size-5" />
    <p>{message}</p>
    {action}
  </div>
);

/**
 * A converted part's display the server answered without a PDF: the
 * conversion refused it (too large, turned away by the converter's checks,
 * a document it cannot render). Another attempt gives the same answer.
 */
const isConversionRefusal = (error: unknown) =>
  APIError.is(error) && error.status === 422;

const FilePartPreview = ({
  fileName,
  kind,
  notConverted,
  row,
  scaleOffset,
  source,
}: {
  fileName: string;
  kind: Exclude<FilePartPreviewKind, "none">;
  /** What shows when the server could not convert a converted part. */
  notConverted: ReactNode;
  row: FilePartRow;
  scaleOffset: number;
  source: FilePartSource;
}) => {
  const t = useTranslations();
  const content = useQuery(
    filePartContentOptions({ ...source, part: row.part }),
  );
  const viewId = filePartViewId({ ...source, part: row.part });

  if (
    content.isError &&
    kind === FILE_PART_PREVIEW_KIND.converted &&
    isConversionRefusal(content.error)
  ) {
    return notConverted;
  }
  if (content.isError) {
    return (
      <PreviewMessage
        action={
          <Button
            onClick={() => {
              detached(content.refetch(), "file-part.preview-retry");
            }}
            size="sm"
            variant="outline"
          >
            {t("common.tryAgain")}
          </Button>
        }
        message={t("common.somethingWentWrong")}
      />
    );
  }
  if (content.data === undefined) {
    return <Skeleton className="size-full rounded-sm" />;
  }
  if (kind === FILE_PART_PREVIEW_KIND.image) {
    return (
      <ImagePreview
        buffer={content.data}
        fileName={fileName}
        mediaType={row.mediaType}
      />
    );
  }
  if (kind === FILE_PART_PREVIEW_KIND.text) {
    const { text, truncated } = decodeFilePartText({
      buffer: content.data,
      charset: row.charset ?? null,
    });
    return (
      <div className="bg-background flex size-full min-h-0 flex-col overflow-hidden rounded-sm">
        {truncated ? (
          <p className="text-muted-foreground shrink-0 border-b px-4 py-2 text-xs">
            {t("emailViewer.previewTruncated")}
          </p>
        ) : null}
        <pre
          className="min-h-0 flex-1 overflow-auto p-4 font-mono text-sm leading-6 wrap-break-word whitespace-pre-wrap"
          dir="auto"
        >
          {text}
        </pre>
      </div>
    );
  }
  if (kind === FILE_PART_PREVIEW_KIND.docx) {
    return (
      <div className="bg-background size-full min-h-0 overflow-hidden rounded-sm">
        <Suspense fallback={<Skeleton className="size-full rounded-sm" />}>
          <ReadOnlyDocxDocument
            documentBuffer={content.data}
            fileName={fileName}
            scaleOffset={scaleOffset}
          />
        </Suspense>
      </div>
    );
  }
  if (
    kind === FILE_PART_PREVIEW_KIND.xlsx ||
    kind === FILE_PART_PREVIEW_KIND.pptx
  ) {
    return (
      <div
        aria-label={fileName}
        className="bg-muted flex size-full min-h-0 flex-col overflow-hidden rounded-sm"
        role="document"
      >
        <Suspense fallback={<Skeleton className="size-full rounded-sm" />}>
          <OfficeDocumentCanvas
            documentBuffer={content.data}
            documentKey={viewId}
            format={kind}
          />
        </Suspense>
      </div>
    );
  }
  // A PDF part, or the PDF the server converted a document part to.
  return (
    <MeasuredPdfProvider
      active
      fallback={{
        error: <PreviewMessage message={t("search.previewUnavailable")} />,
        suspense: <Skeleton className="size-full rounded-sm" />,
      }}
      fieldId={viewId}
      initialScaleOffset={scaleOffset}
      key={viewId}
      surface="file-part-pdf"
    >
      <PDFViewport
        buffer={content.data}
        className="document-preview-surface h-full w-full"
        contentClassName="relative space-y-2 px-2 pt-2"
        fileId={viewId}
        pageSource="portfolio"
        renderPage={(props) => <PDFPage {...props} />}
        scaleOffset={scaleOffset}
      />
    </MeasuredPdfProvider>
  );
};

const ImagePreview = ({
  buffer,
  fileName,
  mediaType,
}: {
  buffer: ArrayBuffer;
  fileName: string;
  mediaType: string;
}) => {
  const t = useTranslations();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useExternalSyncEffect(() => {
    const url = URL.createObjectURL(new Blob([buffer], { type: mediaType }));
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [buffer, mediaType]);

  if (failed) {
    return (
      <PreviewMessage
        action={
          <Button
            onClick={() => {
              setFailed(false);
              setAttempt((current) => current + 1);
            }}
            size="sm"
            variant="outline"
          >
            {t("common.tryAgain")}
          </Button>
        }
        message={t("common.somethingWentWrong")}
      />
    );
  }
  if (objectUrl === null) {
    return <Skeleton className="size-full rounded-sm" />;
  }
  return (
    <img
      alt={fileName}
      className="m-auto max-h-full max-w-full object-contain"
      key={attempt}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={objectUrl}
    />
  );
};

/**
 * Which part of a container is open in place, if any. A part that is no
 * longer listed (the file changed) closes on its own.
 */
export const useOpenFilePart = <TRow extends FilePartRow>(
  rows: readonly TRow[],
) => {
  const [openPart, setOpenPart] = useState<string | null>(null);
  const open = rows.find(({ part }) => part === openPart) ?? null;
  return {
    open,
    openPart: setOpenPart,
    close: () => setOpenPart(null),
  };
};
