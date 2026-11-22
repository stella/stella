import { createContext, type ReactNode, use } from "react";

import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import type { FilePartDescriptor } from "@stll/api-contract/file-parts";
import { Button } from "@stll/ui/button";
import { DocumentMark } from "@stll/ui/document-mark";
import { formatFileSize } from "@stll/ui/file-size";
import { Separator } from "@stll/ui/separator";
import { Text } from "@stll/ui/text";

import {
  type FileGlyphFamily,
  fileTypeIcon,
  fileTypeLabel,
} from "@/components/file-part-list.logic";
import {
  ArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  MailIcon,
  MonitorIcon,
} from "@/icons.gen";
import { useUiColors } from "@/theme";

/**
 * Opens a part of the document on screen (an attachment, the document a
 * signed file wraps, a container's member) the way the document itself
 * opens. Absent where parts cannot be opened, such as a build without the
 * native viewer.
 */
type FilePartOpener = {
  readonly open: (part: string) => void;
  /** The part being fetched, whose row shows that it is busy. */
  readonly opening: string | null;
};

const FilePartOpenerContext = createContext<FilePartOpener | null>(null);

export const FilePartOpenerProvider = ({
  children,
  opener,
}: {
  children: ReactNode;
  opener: FilePartOpener | null;
}) => <FilePartOpenerContext value={opener}>{children}</FilePartOpenerContext>;

const GLYPHS = {
  image: FileImageIcon,
  text: FileTextIcon,
  wordProcessing: FileTextIcon,
  spreadsheet: FileSpreadsheetIcon,
  presentation: MonitorIcon,
  email: MailIcon,
  archive: ArchiveIcon,
  xml: FileCodeIcon,
  unknown: FileIcon,
} as const satisfies Record<FileGlyphFamily, unknown>;

const ICON_SIZE = 18;

const FileTypeGlyph = ({
  color,
  fileName,
  mediaType,
}: {
  color: string;
  fileName: string | null;
  mediaType: string;
}) => {
  const icon = fileTypeIcon(mediaType, fileName);
  if (icon.type === "mark") {
    return <DocumentMark color={color} kind={icon.mark} size={ICON_SIZE} />;
  }
  const Glyph = GLYPHS[icon.family];
  return <Glyph color={color} size={ICON_SIZE} />;
};

/** One part as a container lists it. */
export type FilePartRowItem = FilePartDescriptor & {
  /** A line the container states about the part, such as its description. */
  readonly detail?: string | null | undefined;
};

/**
 * One part as a row, the same in every container: its type's icon, its name,
 * its format and size, and any line the container states about it. The whole
 * row opens the part; while it is being fetched, a spinner takes the icon's
 * place.
 */
export const FilePartRow = ({
  divided = false,
  item: { detail, fileName, mediaType, part, sizeBytes },
}: {
  /** A hairline under the row, between it and the next. */
  divided?: boolean;
  item: FilePartRowItem;
}) => {
  const opener = use(FilePartOpenerContext);
  const t = useTranslations("fileParts");
  const format = useFormatter();
  const ui = useUiColors();
  const name = fileName ?? t("unnamed");
  const details = [
    fileTypeLabel(mediaType, fileName),
    formatFileSize(sizeBytes, format),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  const icon = (
    <View className="pt-0.5">
      <FileTypeGlyph
        color={ui.mutedForeground}
        fileName={fileName}
        mediaType={mediaType}
      />
    </View>
  );
  const text = (
    <View className="flex-1 gap-0.5">
      <Text numberOfLines={2} variant="rowTitle">
        {name}
      </Text>
      <Text numberOfLines={1} variant="caption">
        {details}
      </Text>
      {detail ? (
        <Text numberOfLines={3} variant="caption">
          {detail}
        </Text>
      ) : null}
    </View>
  );
  const separator = divided ? (
    <Separator className="absolute inset-x-0 bottom-0" />
  ) : null;
  if (opener === null) {
    return (
      <View className="min-h-11 w-full flex-row items-start gap-3 py-3">
        {separator}
        {icon}
        {text}
      </View>
    );
  }
  return (
    <Button
      accessibilityLabel={t("open", { fileName: name, details })}
      icon={icon}
      loading={opener.opening === part}
      onPress={() => {
        opener.open(part);
      }}
      size="row"
      variant="ghost"
    >
      {separator}
      {text}
    </Button>
  );
};

/**
 * The files inside a file, as one list in every container: an email's or a
 * data-box message's attachments, a signed container's documents, an
 * invoice's attached files.
 */
export const FilePartList = ({
  items,
  title,
}: {
  items: readonly FilePartRowItem[];
  /** The list's heading; the container's own name for its parts. */
  title?: string | undefined;
}) => {
  const t = useTranslations("fileParts");
  if (items.length === 0) {
    return null;
  }
  return (
    <View>
      <Text accessibilityRole="header" variant="section">
        {title ?? t("attachments")}
      </Text>
      {items.map((item, index) => (
        <FilePartRow
          divided={index < items.length - 1}
          item={item}
          key={item.part}
        />
      ))}
    </View>
  );
};
