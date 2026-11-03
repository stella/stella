import type { ComponentProps } from "react";

import { panic } from "better-result";

import { documentFormat } from "@stll/api-contract/document-format";
import { DocumentMark, isDocumentMarkKind } from "@stll/ui/document-mark";
import {
  FileIcon as File,
  FileImageIcon as FileImage,
  FileTextIcon as FileText,
  MailIcon,
} from "@stll/ui/icons";

import { FileThumbnailIcon } from "@/components/file-thumbnail";
import type { MatterFileThumbnailRef } from "@/components/file-thumbnail";

// The mark is pinned after the spread, so no caller swaps it.
type MarkProps = Omit<ComponentProps<typeof DocumentMark>, "kind">;

export const DocxIcon = (props: MarkProps) => (
  <DocumentMark {...props} kind="word" />
);

export const XlsxIcon = (props: MarkProps) => (
  <DocumentMark {...props} kind="excel" />
);

export const CsvIcon = (props: MarkProps) => (
  <DocumentMark {...props} kind="csv" />
);

type DocumentIconProps = {
  mimeType?: string | null | undefined;
  fileName?: string | null | undefined;
  className?: string | undefined;
  /**
   * The matter file this icon stands for. An image that has a generated
   * preview then shows it, tiny, in the icon's slot; every other file (and an
   * image whose preview is missing or fails) keeps its type icon.
   */
  thumbnail?: MatterFileThumbnailRef | null | undefined;
};

/**
 * A file's icon by its format: the format's own mark where it has one (the
 * mobile app draws the same marks), else the glyph of its family.
 */
export const DocumentIcon = ({
  mimeType,
  fileName,
  className,
  thumbnail,
}: DocumentIconProps) => {
  const { kind } = documentFormat(mimeType, fileName);

  if (kind === "image" && thumbnail?.hasThumbnail) {
    return (
      <FileThumbnailIcon
        className={className}
        fallbackIcon={<FileImage className={className} />}
        fieldId={thumbnail.fieldId}
        hasThumbnail
        workspaceId={thumbnail.workspaceId}
      />
    );
  }

  if (isDocumentMarkKind(kind)) {
    return <DocumentMark className={className} kind={kind} />;
  }

  switch (kind) {
    case "image":
      return <FileImage className={className} />;
    case "email":
      return <MailIcon className={className} />;
    case "text":
      return <FileText className={className} />;
    case "file":
      return <File className={className} />;
    default:
      kind satisfies never;
      return panic("Unhandled document format kind");
  }
};
