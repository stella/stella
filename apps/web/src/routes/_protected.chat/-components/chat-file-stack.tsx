import { useId, useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import { buttonVariants } from "@stll/ui/button";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { useReferenceActivation } from "@/components/references/reference-chip";
import Tooltip from "@/components/tooltip";
import { EntityIcon } from "@/components/workspaces/entity-kind-icon";
import type { ChatThreadAttachedFiles } from "@/features/chat/queries";
import { userFileContentUrl } from "@/lib/user-files";

import { layoutFileStack } from "./chat-file-stack.logic";
import type { FileStackLayout } from "./chat-file-stack.logic";

type AttachedFile = ChatThreadAttachedFiles["files"][number];

/**
 * A chat's attached files as a compact stack of file-type tiles, at the
 * avatar stacks' weight: up to three tiles, then "+N". Hovering lists the
 * names. Renders nothing for a chat without attachments.
 */
export const ChatFileStack = ({
  attachedFiles,
}: {
  attachedFiles: ChatThreadAttachedFiles;
}) => {
  const t = useTranslations();
  const layout = layoutFileStack(attachedFiles);
  if (layout.total === 0) {
    return null;
  }

  return (
    <Tooltip
      content={<FileNameList attachedFiles={attachedFiles} />}
      render={<span className="flex shrink-0" />}
    >
      <FileTiles layout={layout} />
      <span className="sr-only">
        {t("workspaces.filesystem.fileCount", { count: layout.total })}
      </span>
    </Tooltip>
  );
};

/**
 * The open chat's file stack in its header. Clicking it lists every attached
 * file; each opens as its chip in the transcript does.
 */
export const ChatThreadFilesButton = ({
  attachedFiles,
}: {
  attachedFiles: ChatThreadAttachedFiles;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const layout = layoutFileStack(attachedFiles);
  if (layout.total === 0) {
    return null;
  }
  const close = () => {
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={t("chat.threadFiles.title")}
        className={cn(buttonVariants({ size: "xs", variant: "ghost" }))}
      >
        <FileTiles layout={layout} />
      </PopoverTrigger>
      <PopoverPanel
        align="end"
        aria-labelledby={titleId}
        className="w-72 max-w-[calc(100vw-2rem)]"
        padding="xs"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="text-muted-foreground px-2 pt-1 pb-0.5 text-xs font-medium"
            id={titleId}
          >
            {t("chat.threadFiles.title")}
          </p>
          <ul className="flex min-w-0 flex-col">
            {attachedFiles.files.map((file) => (
              <li className="min-w-0" key={`${file.type}-${file.id}`}>
                <ThreadFileRow file={file} onOpen={close} />
              </li>
            ))}
          </ul>
          {layout.unnamedCount > 0 ? (
            <p className="text-muted-foreground px-2 pb-1 text-xs">
              {t("chat.historyContext.unnamed", {
                count: layout.unnamedCount,
              })}
            </p>
          ) : null}
        </div>
      </PopoverPanel>
    </Popover>
  );
};

const TILE_CLASS =
  "bg-muted ring-background flex size-6 shrink-0 items-center justify-center rounded-md ring-2";

const FileGlyph = ({
  className,
  file,
}: {
  className: string;
  file: AttachedFile;
}) => (
  <EntityIcon
    className={className}
    source={{
      fileName: file.name,
      kind: file.kind,
      mimeType: file.mimeType,
      type: "resolved",
    }}
  />
);

const FileTiles = ({ layout }: { layout: FileStackLayout<AttachedFile> }) => {
  const t = useTranslations();
  return (
    <span aria-hidden="true" className="flex items-center -space-x-1">
      {layout.tiles.map((file) => (
        <span className={TILE_CLASS} key={`${file.type}-${file.id}`}>
          <FileGlyph className="size-3.5" file={file} />
        </span>
      ))}
      {layout.overflowCount > 0 ? (
        <span
          className={cn(
            TILE_CLASS,
            "text-muted-foreground text-3xs relative z-10 font-medium tabular-nums",
          )}
        >
          {t("chat.historyContext.overflow", { count: layout.overflowCount })}
        </span>
      ) : null}
    </span>
  );
};

const FileNameList = ({
  attachedFiles,
}: {
  attachedFiles: ChatThreadAttachedFiles;
}) => {
  const t = useTranslations();
  const { total, unnamedCount } = layoutFileStack(attachedFiles);
  return (
    <div className="flex min-w-0 flex-col gap-1 py-0.5">
      <p className="text-muted-foreground">
        {t("workspaces.filesystem.fileCount", { count: total })}
      </p>
      <ul className="flex min-w-0 flex-col gap-0.5">
        {attachedFiles.files.map((file) => (
          <li
            className="flex min-w-0 items-center gap-1.5"
            key={`${file.type}-${file.id}`}
          >
            <FileGlyph className="size-3 shrink-0" file={file} />
            <BidiText as="span" className="min-w-0 truncate">
              {file.name}
            </BidiText>
          </li>
        ))}
      </ul>
      {unnamedCount > 0 ? (
        <p className="text-muted-foreground">
          {t("chat.historyContext.unnamed", { count: unnamedCount })}
        </p>
      ) : null}
    </div>
  );
};

const ROW_CLASS = cn(
  buttonVariants({ size: "row", variant: "ghost" }),
  "w-full min-w-0 justify-start gap-2",
);

const ThreadFileRow = ({
  file,
  onOpen,
}: {
  file: AttachedFile;
  onOpen: () => void;
}) => {
  switch (file.type) {
    case "upload":
      // An upload opens as its attachment chip does: the stored bytes in a
      // new tab.
      return (
        <a
          className={ROW_CLASS}
          href={sanitizeHref(userFileContentUrl(file.id))}
          onClick={onOpen}
          rel="noreferrer"
          target="_blank"
        >
          <ThreadFileRowContent file={file} />
        </a>
      );
    case "entity":
      return <MatterFileRow file={file} onOpen={onOpen} />;
    default: {
      file satisfies never;
      return panic(`Unhandled attached file: ${String(file)}`);
    }
  }
};

/** A matter document opens as its reference chip does. */
const MatterFileRow = ({
  file,
  onOpen,
}: {
  file: Extract<AttachedFile, { type: "entity" }>;
  onOpen: () => void;
}) => {
  const activate = useReferenceActivation({
    entityId: file.id,
    entityKind: file.kind,
    label: file.name,
    matterId: file.matterId,
    mimeType: null,
    type: "entity",
  });
  return (
    <button
      className={ROW_CLASS}
      onClick={() => {
        activate?.();
        onOpen();
      }}
      type="button"
    >
      <ThreadFileRowContent file={file} />
    </button>
  );
};

const ThreadFileRowContent = ({ file }: { file: AttachedFile }) => (
  <>
    <FileGlyph className="size-4 shrink-0" file={file} />
    <BidiText as="span" className="min-w-0 truncate">
      {file.name}
    </BidiText>
  </>
);
