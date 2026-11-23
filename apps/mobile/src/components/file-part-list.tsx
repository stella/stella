import { createContext, type ReactNode, use, useState } from "react";

import { Result } from "better-result";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { opensToFilesInside } from "@stll/api-contract/file-part-containers";
import type {
  ContainedFile,
  FilePartDescriptor,
  FilePartList as ContainedFiles,
} from "@stll/api-contract/file-parts";
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
  /**
   * Opens `part`; its media type decides whether it opens as itself or as
   * the PDF the server converts it to, as a stored file of the type would.
   */
  readonly open: (part: string, mediaType: string) => void;
  /** The part being fetched, whose row shows that it is busy. */
  readonly opening: string | null;
  /** The files of a part that is itself a container, such as an email. */
  readonly list: (part: string) => Promise<Result<ContainedFiles, unknown>>;
};

/** A container part's files, as its row shows them under itself. */
type FilesInside =
  | { readonly status: "closed" }
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "open"; readonly files: readonly ContainedFile[] };

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
  const document = useTranslations("document");
  const format = useFormatter();
  const ui = useUiColors();
  const [inside, setInside] = useState<FilesInside>({ status: "closed" });
  // A container (an email, an archive) opens to its own files under its row.
  const container =
    opener !== null && opensToFilesInside({ fileName, mediaType, part });
  const toggleInside = async (list: FilePartOpener["list"]) => {
    if (inside.status === "open" || inside.status === "loading") {
      setInside({ status: "closed" });
      return;
    }
    setInside({ status: "loading" });
    const listed = await list(part);
    setInside(
      Result.isOk(listed)
        ? { status: "open", files: listed.value.files }
        : { status: "failed" },
    );
  };
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
  const row = (
    <Button
      accessibilityLabel={t("open", { fileName: name, details })}
      {...(container
        ? { accessibilityState: { expanded: inside.status === "open" } }
        : {})}
      icon={icon}
      loading={opener.opening === part || inside.status === "loading"}
      onPress={() => {
        if (container) {
          void toggleInside(opener.list);
          return;
        }
        opener.open(part, mediaType);
      }}
      size="row"
      variant="ghost"
    >
      {separator}
      {text}
    </Button>
  );
  if (!container || inside.status === "closed" || inside.status === "loading") {
    return row;
  }
  return (
    <View>
      {row}
      <View className="gap-2 ps-6">
        {inside.status === "failed" ? (
          <Text variant="caption">{t("insideFailed")}</Text>
        ) : (
          <ContainedFileList files={inside.files} />
        )}
        {/* The container itself still opens as a file, as any part does. */}
        <Button
          loading={opener.opening === part}
          onPress={() => {
            opener.open(part, mediaType);
          }}
          size="sm"
          variant="outline"
        >
          {document("openOriginal")}
        </Button>
      </View>
    </View>
  );
};

/** A file a container lists that does not open, and why. */
const UnavailableFileRow = ({
  divided,
  file,
}: {
  divided: boolean;
  file: ContainedFile;
}) => {
  const t = useTranslations("fileParts");
  const format = useFormatter();
  const ui = useUiColors();
  const details = [
    file.folder,
    file.unavailable === null ? null : t(`unavailable.${file.unavailable}`),
    formatFileSize(file.sizeBytes, format),
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");
  return (
    <View
      accessible
      accessibilityLabel={`${file.fileName}, ${details}`}
      className="min-h-11 w-full flex-row items-start gap-3 py-3 opacity-70"
    >
      {divided ? <Separator className="absolute inset-x-0 bottom-0" /> : null}
      <View className="pt-0.5">
        <FileTypeGlyph
          color={ui.mutedForeground}
          fileName={file.fileName}
          mediaType="application/octet-stream"
        />
      </View>
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={2} variant="rowTitle">
          {file.fileName}
        </Text>
        <Text numberOfLines={2} variant="caption">
          {details}
        </Text>
      </View>
    </View>
  );
};

/**
 * The files a container holds, in its order, whether or not they open: a
 * ZIP archive's files with their folders, or the files of a part that is
 * itself a container. A file that opens is a part row; one that does not
 * says why.
 */
export const ContainedFileList = ({
  files,
  title,
}: {
  files: readonly ContainedFile[];
  /** The list's heading, when it stands on its own. */
  title?: string | undefined;
}) => {
  const t = useTranslations("fileParts");
  if (files.length === 0) {
    return <Text variant="caption">{t("noFilesInside")}</Text>;
  }
  return (
    <View>
      {title === undefined ? null : (
        <Text accessibilityRole="header" variant="section">
          {title}
        </Text>
      )}
      {files.map((file, index) => {
        const divided = index < files.length - 1;
        return file.part === null ? (
          <UnavailableFileRow
            divided={divided}
            file={file}
            key={`unavailable:${String(index)}`}
          />
        ) : (
          <FilePartRow
            divided={divided}
            item={{ ...file.part, detail: file.folder }}
            key={file.part.part}
          />
        );
      })}
    </View>
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
