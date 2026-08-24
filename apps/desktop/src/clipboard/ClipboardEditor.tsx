import { Fragment, forwardRef, memo, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BoldIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  StrikethroughIcon,
  UnderlineIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { cn } from "@stll/ui/utils";

import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { isClipboardEditorContext } from "./clipboard-types";
import type { ClipboardEditorContext } from "./clipboard-types";

type SaveState =
  | { type: "idle" }
  | { type: "saving" }
  | { message: string; type: "error" };

const EDITOR_HEADER_PADDING_CLASS = navigator.userAgent.includes("Macintosh")
  ? "ps-24"
  : "ps-5";

type EditorState =
  | { type: "loading" }
  | { message: string; type: "error" }
  | {
      context: ClipboardEditorContext;
      groupId: string | null;
      save: SaveState;
      type: "ready";
    };

const closeEditor = async () => {
  await invoke("clipboard_close_editor");
};

type FormatCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "bulletedList"
  | "numberedList";

const applyFormat = (editor: HTMLDivElement, command: FormatCommand) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }
  const range = selection.getRangeAt(0);
  if (range.collapsed || !editor.contains(range.commonAncestorContainer)) {
    return;
  }
  const inlineTags = {
    bold: "strong",
    italic: "em",
    strikethrough: "s",
    underline: "u",
  } as const satisfies Record<
    Exclude<FormatCommand, "bulletedList" | "numberedList">,
    string
  >;
  let formatted: HTMLElement;
  if (command === "bulletedList" || command === "numberedList") {
    formatted = document.createElement(
      command === "bulletedList" ? "ul" : "ol",
    );
    const item = document.createElement("li");
    item.append(range.extractContents());
    formatted.append(item);
  } else {
    formatted = document.createElement(inlineTags[command]);
    formatted.append(range.extractContents());
  }
  range.insertNode(formatted);
  selection.removeAllRanges();
  const formattedRange = document.createRange();
  formattedRange.selectNodeContents(formatted);
  selection.addRange(formattedRange);
  editor.focus();
};

const EDITOR_BLOCK_TAGS = new Set([
  "BLOCKQUOTE",
  "DIV",
  "LI",
  "OL",
  "P",
  "PRE",
  "UL",
]);

const editorPlainText = (editor: HTMLDivElement) => {
  const parts: string[] = [];
  const appendLineBreak = () => {
    if (parts.at(-1) !== "\n") {
      parts.push("\n");
    }
  };
  const isBlock = (node: Node) =>
    node instanceof HTMLElement && EDITOR_BLOCK_TAGS.has(node.tagName);
  const appendNode = (node: Node) => {
    if (node instanceof Text) {
      parts.push(node.data);
      return;
    }
    if (!(node instanceof HTMLElement)) {
      return;
    }
    if (node.tagName === "BR") {
      parts.push("\n");
      return;
    }
    const children = Array.from(node.childNodes);
    for (const [index, child] of children.entries()) {
      appendNode(child);
      const nextChild = children.at(index + 1);
      if (nextChild && (isBlock(child) || isBlock(nextChild))) {
        appendLineBreak();
      }
    }
  };

  const children = Array.from(editor.childNodes);
  for (const [index, child] of children.entries()) {
    appendNode(child);
    const nextChild = children.at(index + 1);
    if (nextChild && (isBlock(child) || isBlock(nextChild))) {
      appendLineBreak();
    }
  }
  return parts.join("");
};

type RichTextAreaProps = {
  item: ClipboardEditorContext["item"];
  label: string;
};

const RichTextArea = memo(
  forwardRef<HTMLDivElement, RichTextAreaProps>(({ item, label }, ref) => {
    const plainTextLines = item.plainText.split("\n");
    const content =
      item.type === "formattedText"
        ? {
            // safe-html: Clipboard HTML was sanitized by Rust before IPC.
            dangerouslySetInnerHTML: { __html: item.html },
          }
        : {
            children: plainTextLines.map((line, index) => (
              <Fragment key={index}>
                {index > 0 ? <br /> : null}
                {line}
              </Fragment>
            )),
          };
    return (
      <div
        aria-label={label}
        autoFocus
        className="clipboard-rich-editor bg-card ring-border focus:ring-ring min-h-0 flex-1 overflow-y-auto rounded-[22px] p-5 text-sm leading-6 ring-1 outline-none ring-inset focus:ring-2"
        contentEditable
        dir="auto"
        ref={ref}
        role="textbox"
        suppressContentEditableWarning
        {...content}
      />
    );
  }),
);

RichTextArea.displayName = "RichTextArea";

const ClipboardEditor = () => {
  const t = useTranslations("clipboard");
  const editorRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<EditorState>({ type: "loading" });
  const loadError = t("errorReadHistory");
  const requestClose = () => {
    closeEditor().catch(() => {
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardEditorClose,
        window: DESKTOP_TELEMETRY_WINDOWS.clipboardEditor,
      });
    });
  };

  useEffect(() => {
    let disposed = false;
    let latestLoad = 0;
    const load = () => {
      latestLoad += 1;
      const loadId = latestLoad;
      void invoke<unknown>("clipboard_get_editor_context")
        .then((value) => {
          if (disposed || loadId !== latestLoad) {
            return undefined;
          }
          if (!isClipboardEditorContext(value)) {
            reportDesktopError({
              code: DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
              operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardEditorRead,
              window: DESKTOP_TELEMETRY_WINDOWS.clipboardEditor,
            });
            setState({ message: loadError, type: "error" });
            return undefined;
          }
          setState({
            context: value,
            groupId: value.item.groupId,
            save: { type: "idle" },
            type: "ready",
          });
          return undefined;
        })
        .catch(() => {
          if (disposed || loadId !== latestLoad) {
            return;
          }
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
            operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardEditorRead,
            window: DESKTOP_TELEMETRY_WINDOWS.clipboardEditor,
          });
          setState({ message: loadError, type: "error" });
        });
    };
    load();
    let stopListening: (() => void) | undefined;
    void listen("clipboard-editor-changed", load)
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return undefined;
        }
        stopListening = unlisten;
        return undefined;
      })
      .catch(() => {
        if (disposed) {
          return;
        }
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
          operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardEditorRead,
          window: DESKTOP_TELEMETRY_WINDOWS.clipboardEditor,
        });
        setState({ message: loadError, type: "error" });
      });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [loadError]);

  const format = (command: FormatCommand) => {
    const editor = editorRef.current;
    if (editor) {
      applyFormat(editor, command);
    }
  };

  const save = () => {
    const editor = editorRef.current;
    if (state.type !== "ready" || !editor) {
      return;
    }
    const plainText = editorPlainText(editor);
    if (!plainText.trim()) {
      return;
    }
    const html = editor.innerHTML;
    setState({
      context: state.context,
      groupId: state.groupId,
      save: { type: "saving" },
      type: "ready",
    });
    void invoke("clipboard_save_editor_item", {
      groupId: state.groupId,
      html,
      id: state.context.item.id,
      plainText,
    })
      .then(closeEditor)
      .catch(() => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardEditorSave,
          window: DESKTOP_TELEMETRY_WINDOWS.clipboardEditor,
        });
        setState({
          context: state.context,
          groupId: state.groupId,
          save: { message: t("errorUpdateHistory"), type: "error" },
          type: "ready",
        });
      });
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      save();
    }
  };

  useEffect(() => {
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (state.type === "loading") {
    return <main className="clipboard-editor-window bg-background min-h-dvh" />;
  }

  if (state.type === "error") {
    return (
      <main className="clipboard-editor-window text-foreground bg-background grid min-h-dvh place-items-center p-8">
        <p className="text-destructive text-sm">{state.message}</p>
      </main>
    );
  }

  const { item } = state.context;
  const sourceName = item.sourceApp?.name;
  const toolbarItems = [
    { command: "bold", icon: BoldIcon, label: t("bold") },
    { command: "italic", icon: ItalicIcon, label: t("italic") },
    { command: "underline", icon: UnderlineIcon, label: t("underline") },
    {
      command: "strikethrough",
      icon: StrikethroughIcon,
      label: t("strikethrough"),
    },
    { command: "bulletedList", icon: ListIcon, label: t("bulletedList") },
    {
      command: "numberedList",
      icon: ListOrderedIcon,
      label: t("numberedList"),
    },
  ] as const;

  return (
    <main className="clipboard-editor-window text-foreground bg-background flex h-dvh min-h-dvh flex-col overflow-hidden">
      <header
        className={cn(
          "border-border flex h-14 shrink-0 items-center gap-3 border-b pe-5",
          EDITOR_HEADER_PADDING_CLASS,
        )}
        data-tauri-drag-region
      >
        <div className="min-w-0 flex-1" data-tauri-drag-region>
          <h1 className="truncate text-sm font-semibold" data-tauri-drag-region>
            {t("editItem")}
          </h1>
          {sourceName ? (
            <p
              className="text-muted-foreground truncate text-xs"
              data-tauri-drag-region
            >
              {sourceName}
            </p>
          ) : null}
        </div>
        <Button
          aria-label={t("close")}
          className="size-11 rounded-full"
          onClick={requestClose}
          size="icon"
          title={t("close")}
          variant="ghost"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
        <div className="bg-muted/60 flex shrink-0 items-center gap-1 rounded-2xl p-1">
          {toolbarItems.map(({ command, icon: Icon, label }) => (
            <Button
              aria-label={label}
              className="size-11 rounded-xl"
              key={command}
              onClick={() => format(command)}
              onMouseDown={(event) => event.preventDefault()}
              size="icon"
              title={label}
              type="button"
              variant="ghost"
            >
              <Icon aria-hidden="true" className="size-4" />
            </Button>
          ))}
        </div>

        <RichTextArea
          item={item}
          key={item.id}
          label={t("clipText")}
          ref={editorRef}
        />

        <div className="flex shrink-0 items-center gap-3">
          <label className="flex min-w-0 flex-1 items-center gap-3">
            <span className="text-muted-foreground shrink-0 text-xs">
              {t("group")}
            </span>
            <Select
              onValueChange={(groupId) => {
                setState({
                  context: state.context,
                  groupId: groupId || null,
                  save: { type: "idle" },
                  type: "ready",
                });
              }}
              value={state.groupId ?? ""}
            >
              <SelectTrigger className="h-10 w-44 min-w-0 rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup
                alignItemWithTrigger={false}
                className="max-h-56"
                side="top"
                sideOffset={8}
              >
                <SelectItem value="">{t("noGroup")}</SelectItem>
                {state.context.groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <Button onClick={requestClose} type="button" variant="ghost">
            {t("cancel")}
          </Button>
          <Button
            disabled={state.save.type === "saving"}
            onClick={save}
            type="button"
          >
            {t("save")}
          </Button>
        </div>
        {state.save.type === "error" ? (
          <p className="text-destructive text-xs" role="alert">
            {state.save.message}
          </p>
        ) : null}
      </div>
    </main>
  );
};

export default ClipboardEditor;
