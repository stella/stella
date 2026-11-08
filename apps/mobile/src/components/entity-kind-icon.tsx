import { panic } from "better-result";

import type { DocumentFormat } from "@stll/api-contract/document-format";
import { DocumentMark, isDocumentMarkKind } from "@stll/ui/document-mark";

import {
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FolderIcon,
  LayersIcon,
  LinkIcon,
  ListTodoIcon,
  MailIcon,
  MessageSquareIcon,
} from "@/icons.gen";

/**
 * A document's icon by its file's format: the format's own mark (the Word,
 * Excel or PDF page the web draws), else the glyph of its family.
 */
const DocumentFormatIcon = ({
  color,
  format,
  size,
}: {
  color: string;
  format: DocumentFormat;
  size: number;
}) => {
  const { kind } = format;
  if (isDocumentMarkKind(kind)) {
    return <DocumentMark color={color} kind={kind} size={size} />;
  }
  switch (kind) {
    case "image":
      return <FileImageIcon color={color} size={size} />;
    case "email":
      return <MailIcon color={color} size={size} />;
    case "text":
      return <FileTextIcon color={color} size={size} />;
    case "file":
      return <FileIcon color={color} size={size} />;
    default:
      kind satisfies never;
      return panic("Unhandled document format kind");
  }
};

/**
 * A matter item's glyph, the web's for its kind (apps/web entity-kind-icon.tsx);
 * a document whose file's format is known draws that format's icon. A matter
 * and a chat, which search lists beside them, draw the glyphs of their tabs.
 */
export const EntityKindIcon = ({
  color,
  format,
  kind,
  size = 18,
}: {
  color: string;
  /** The document's file format, when the list knows it. */
  format?: DocumentFormat | undefined;
  kind: string;
  size?: number;
}) => {
  if (kind === "document" && format !== undefined) {
    return <DocumentFormatIcon color={color} format={format} size={size} />;
  }
  switch (kind) {
    case "folder":
      return <FolderIcon color={color} size={size} />;
    case "task":
      return <ListTodoIcon color={color} size={size} />;
    case "message":
      return <MailIcon color={color} size={size} />;
    case "link":
      return <LinkIcon color={color} size={size} />;
    case "document":
      return <FileTextIcon color={color} size={size} />;
    case "matter":
      return <LayersIcon color={color} size={size} />;
    case "chat":
      return <MessageSquareIcon color={color} size={size} />;
    default:
      return <FileIcon color={color} size={size} />;
  }
};
