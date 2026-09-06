import { Fragment, forwardRef, memo, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import {
  BoldIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  StrikethroughIcon,
  UnderlineIcon,
  XIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { cn } from "@stll/ui/utils";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  describeError,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import {
  clipboardSourceLabel,
  clipboardSourceTitle,
  hasClipboardPrimaryModifier,
} from "./clipboard-logic";
import { isClipboardEditorContext } from "./clipboard-types";
import type { ClipboardEditorContext } from "./clipboard-types";
import { ClipboardImagePreview } from "./ClipboardImagePreview";
import { ClipboardSourceIcon } from "./ClipboardSourceIcon";

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

type InlineFormatCommand = Exclude<
  FormatCommand,
  "bulletedList" | "numberedList"
>;

const INLINE_FORMATS = {
  bold: { element: "strong", tags: ["b", "strong"] },
  italic: { element: "em", tags: ["em", "i"] },
  strikethrough: { element: "s", tags: ["s", "strike"] },
  underline: { element: "u", tags: ["u"] },
} as const satisfies Record<
  InlineFormatCommand,
  { element: string; tags: readonly string[] }
>;

const EDITOR_BLOCK_TAGS = new Set([
  "BLOCKQUOTE",
  "DIV",
  "LI",
  "OL",
  "P",
  "PRE",
  "TABLE",
  "TBODY",
  "TFOOT",
  "THEAD",
  "TR",
  "UL",
]);

/** Cells sit side by side: plain text separates them with a tab, rows with a newline. */
const EDITOR_CELL_TAGS = new Set(["TD", "TH"]);

const listItemsFromSelection = (fragment: DocumentFragment) => {
  const items: HTMLLIElement[] = [];
  let item = document.createElement("li");
  const finishItem = (includeEmpty = false) => {
    if (!item.hasChildNodes() && !includeEmpty) {
      return;
    }
    if (!item.hasChildNodes()) {
      item.append(document.createElement("br"));
    }
    items.push(item);
    item = document.createElement("li");
  };
  const appendWithInlineAncestors = (node: Node, ancestors: HTMLElement[]) => {
    let parent: HTMLElement = item;
    for (const ancestor of ancestors) {
      const wrapper = document.createElement(ancestor.localName);
      for (const attribute of Array.from(ancestor.attributes)) {
        wrapper.setAttribute(attribute.name, attribute.value);
      }
      parent.append(wrapper);
      parent = wrapper;
    }
    parent.append(node.cloneNode(true));
  };
  const appendNode = (node: Node, ancestors: HTMLElement[]) => {
    if (node instanceof Text) {
      appendWithInlineAncestors(node, ancestors);
      return;
    }
    if (!(node instanceof HTMLElement)) {
      return;
    }
    if (node instanceof HTMLElement && node.tagName === "BR") {
      finishItem(true);
      return;
    }
    if (EDITOR_BLOCK_TAGS.has(node.tagName)) {
      finishItem();
      for (const child of Array.from(node.childNodes)) {
        appendNode(child, ancestors);
      }
      finishItem();
      return;
    }
    if (!node.hasChildNodes()) {
      appendWithInlineAncestors(node, ancestors);
      return;
    }
    const nestedAncestors = ancestors.concat(node);
    for (const child of Array.from(node.childNodes)) {
      appendNode(child, nestedAncestors);
    }
  };

  for (const node of Array.from(fragment.childNodes)) {
    appendNode(node, []);
  }
  finishItem();
  return items;
};

const shallowCloneElement = (source: HTMLElement) => {
  const clone = document.createElement(source.localName);
  for (const attribute of Array.from(source.attributes)) {
    clone.setAttribute(attribute.name, attribute.value);
  }
  return clone;
};

const isFormatElement = (element: HTMLElement, tags: readonly string[]) =>
  tags.includes(element.localName);

const hasFormatAncestor = (
  node: Node,
  editor: HTMLDivElement,
  tags: readonly string[],
) => {
  let ancestor = node instanceof HTMLElement ? node : node.parentElement;
  while (ancestor && ancestor !== editor) {
    if (isFormatElement(ancestor, tags)) {
      return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
};

const rangeSelectsNodeContent = (range: Range, node: Node) => {
  if (!range.intersectsNode(node)) {
    return false;
  }
  if (!(node instanceof Text)) {
    return true;
  }
  const start = node === range.startContainer ? range.startOffset : 0;
  const end = node === range.endContainer ? range.endOffset : node.length;
  return start < end;
};

const selectionIsFormatted = (
  editor: HTMLDivElement,
  range: Range,
  tags: readonly string[],
) => {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ALL);
  let hasSelectedFormattedBreak = false;
  let hasSelectedFormattedText = false;
  let node = walker.nextNode();
  while (node) {
    if (
      node instanceof Text &&
      node.length > 0 &&
      rangeSelectsNodeContent(range, node)
    ) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      const selectedText = node.data.slice(start, end);
      if (hasFormatAncestor(node, editor, tags)) {
        hasSelectedFormattedText = true;
      } else if (selectedText.trim()) {
        return false;
      }
    }
    if (
      node instanceof HTMLElement &&
      node.tagName === "BR" &&
      rangeSelectsNodeContent(range, node) &&
      hasFormatAncestor(node, editor, tags)
    ) {
      hasSelectedFormattedBreak = true;
    }
    node = walker.nextNode();
  }
  return hasSelectedFormattedText || hasSelectedFormattedBreak;
};

const outermostFormatAncestor = (
  node: Node,
  otherBoundary: Node,
  editor: HTMLDivElement,
  tags: readonly string[],
) => {
  let ancestor = node instanceof HTMLElement ? node : node.parentElement;
  let match: HTMLElement | null = null;
  while (ancestor && ancestor !== editor) {
    if (isFormatElement(ancestor, tags) && ancestor.contains(otherBoundary)) {
      match = ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return match;
};

const fragmentHasContent = (fragment: DocumentFragment) =>
  Boolean(fragment.textContent) || fragment.querySelector("br") !== null;

const removeFormatFromFragment = (
  fragment: DocumentFragment,
  tags: readonly string[],
) => {
  for (const element of Array.from(fragment.querySelectorAll(tags.join(",")))) {
    element.replaceWith(...Array.from(element.childNodes));
  }
};

const removeInlineFormat = (
  editor: HTMLDivElement,
  range: Range,
  selection: Selection,
  tags: readonly string[],
) => {
  if (!selectionIsFormatted(editor, range, tags)) {
    return false;
  }

  const formattedAncestor = outermostFormatAncestor(
    range.startContainer,
    range.endContainer,
    editor,
    tags,
  );
  if (!formattedAncestor?.parentNode) {
    const selected = range.extractContents();
    removeFormatFromFragment(selected, tags);
    const selectedNodes = Array.from(selected.childNodes);
    const firstSelectedNode = selectedNodes.at(0);
    const lastSelectedNode = selectedNodes.at(-1);
    if (!firstSelectedNode || !lastSelectedNode) {
      return false;
    }
    range.insertNode(selected);
    selection.removeAllRanges();
    const unformattedRange = document.createRange();
    unformattedRange.setStartBefore(firstSelectedNode);
    unformattedRange.setEndAfter(lastSelectedNode);
    selection.addRange(unformattedRange);
    editor.focus();
    return true;
  }

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(formattedAncestor);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const before = beforeRange.cloneContents();

  const afterRange = document.createRange();
  afterRange.selectNodeContents(formattedAncestor);
  afterRange.setStart(range.endContainer, range.endOffset);
  const after = afterRange.cloneContents();

  const selected = range.cloneContents();
  removeFormatFromFragment(selected, tags);

  const sharedAncestors: HTMLElement[] = [];
  let ancestor =
    range.startContainer instanceof HTMLElement
      ? range.startContainer
      : range.startContainer.parentElement;
  while (ancestor && ancestor !== formattedAncestor) {
    if (
      ancestor.contains(range.endContainer) &&
      !isFormatElement(ancestor, tags)
    ) {
      sharedAncestors.push(ancestor);
    }
    ancestor = ancestor.parentElement;
  }

  const unformatted = document.createDocumentFragment();
  let selectedParent: DocumentFragment | HTMLElement = unformatted;
  for (const sharedAncestor of sharedAncestors.toReversed()) {
    const wrapper = shallowCloneElement(sharedAncestor);
    selectedParent.append(wrapper);
    selectedParent = wrapper;
  }
  selectedParent.append(selected);

  const selectedNodes = Array.from(unformatted.childNodes);
  const firstSelectedNode = selectedNodes.at(0);
  const lastSelectedNode = selectedNodes.at(-1);
  if (!firstSelectedNode || !lastSelectedNode) {
    return false;
  }

  const replacement = document.createDocumentFragment();
  if (fragmentHasContent(before)) {
    const beforeWrapper = shallowCloneElement(formattedAncestor);
    beforeWrapper.append(before);
    replacement.append(beforeWrapper);
  }
  replacement.append(unformatted);
  if (fragmentHasContent(after)) {
    const afterWrapper = shallowCloneElement(formattedAncestor);
    afterWrapper.append(after);
    replacement.append(afterWrapper);
  }

  formattedAncestor.before(replacement);
  formattedAncestor.remove();

  selection.removeAllRanges();
  const unformattedRange = document.createRange();
  unformattedRange.setStartBefore(firstSelectedNode);
  unformattedRange.setEndAfter(lastSelectedNode);
  selection.addRange(unformattedRange);
  editor.focus();
  return true;
};

/** Returns whether the editor content changed. */
const applyFormat = (editor: HTMLDivElement, command: FormatCommand) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }
  const range = selection.getRangeAt(0);
  if (range.collapsed || !editor.contains(range.commonAncestorContainer)) {
    return false;
  }
  if (command === "bulletedList" || command === "numberedList") {
    const formatted = document.createElement(
      command === "bulletedList" ? "ul" : "ol",
    );
    for (const item of listItemsFromSelection(range.extractContents())) {
      formatted.append(item);
    }
    range.insertNode(formatted);
    selection.removeAllRanges();
    const formattedRange = document.createRange();
    formattedRange.selectNodeContents(formatted);
    selection.addRange(formattedRange);
    editor.focus();
    return true;
  }
  const inlineFormat = INLINE_FORMATS[command];
  if (removeInlineFormat(editor, range, selection, inlineFormat.tags)) {
    return true;
  }
  const formatted = document.createElement(inlineFormat.element);
  formatted.append(range.extractContents());
  range.insertNode(formatted);
  selection.removeAllRanges();
  const formattedRange = document.createRange();
  formattedRange.selectNodeContents(formatted);
  selection.addRange(formattedRange);
  editor.focus();
  return true;
};

const editorPlainText = (editor: HTMLDivElement) => {
  const parts: string[] = [];
  const appendLineBreak = () => {
    if (parts.at(-1) !== "\n") {
      parts.push("\n");
    }
  };
  const isBlock = (node: Node) =>
    node instanceof HTMLElement && EDITOR_BLOCK_TAGS.has(node.tagName);
  const isCell = (node: Node) =>
    node instanceof HTMLElement && EDITOR_CELL_TAGS.has(node.tagName);
  const appendSeparator = (child: Node, nextChild: Node | undefined) => {
    if (!nextChild) {
      return;
    }
    if (isCell(child) && isCell(nextChild)) {
      parts.push("\t");
      return;
    }
    if (isBlock(child) || isBlock(nextChild)) {
      appendLineBreak();
    }
  };
  const appendChildren = (node: Node) => {
    const children = Array.from(node.childNodes);
    for (const [index, child] of children.entries()) {
      appendNode(child);
      appendSeparator(child, children.at(index + 1));
    }
  };
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
    appendChildren(node);
  };

  appendChildren(editor);
  return parts.join("");
};

type RichTextAreaProps = {
  item: Exclude<ClipboardEditorContext["item"], { type: "image" }>;
  label: string;
  onInput: () => void;
};

const RichTextArea = memo(
  forwardRef<HTMLDivElement, RichTextAreaProps>(
    ({ item, label, onInput }, ref) => {
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
          className="clipboard-rich-editor clipboard-html bg-card ring-border focus:ring-ring min-h-0 flex-1 overflow-y-auto rounded-[22px] p-5 text-sm leading-6 tab-4 ring-1 outline-none ring-inset focus:ring-2"
          contentEditable
          dir="auto"
          onInput={onInput}
          ref={ref}
          role="textbox"
          suppressContentEditableWarning
          {...content}
        />
      );
    },
  ),
);

RichTextArea.displayName = "RichTextArea";

const ClipboardEditor = () => {
  const t = useTranslations("clipboard");
  const formatter = useFormatter();
  const editorRef = useRef<HTMLDivElement>(null);
  // Text and HTML are regenerated from the DOM on save and never round-trip
  // byte-for-byte, so an untouched editor submits the stored content instead:
  // a group-only save must not read as a content edit.
  const editedRef = useRef(false);
  const [state, setState] = useState<EditorState>({ type: "loading" });
  const loadError = t("errorReadHistory");
  const requestClose = () => {
    closeEditor().catch((error: unknown) => {
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        detail: describeError(error),
        operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardEditorClose,
        window: DESKTOP_TELEMETRY_WINDOWS.clipboardEditor,
      });
      setState((current) => {
        if (current.type !== "ready") {
          return current;
        }
        return {
          context: current.context,
          groupId: current.groupId,
          save: { message: t("errorUpdateHistory"), type: "error" },
          type: "ready",
        };
      });
    });
  };

  useEffect(() => {
    let disposed = false;
    const loadContext = () => {
      void invoke<unknown>("clipboard_get_editor_context")
        .then((value) => {
          if (disposed) {
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
          setState((current) => {
            if (current.type !== "ready") {
              return {
                context: value,
                groupId: value.item.groupId,
                save: { type: "idle" },
                type: "ready",
              };
            }
            // A refresh must not touch the text being edited or the user's
            // group choice; it only takes what resolves underneath an open
            // editor.
            return {
              ...current,
              context: {
                ...current.context,
                groups: value.groups,
                sourceAppVisual: value.sourceAppVisual,
              },
            };
          });
          return undefined;
        })
        .catch((error: unknown) => {
          if (disposed) {
            return;
          }
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
            detail: describeError(error),
            operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardEditorRead,
            window: DESKTOP_TELEMETRY_WINDOWS.clipboardEditor,
          });
          setState({ message: loadError, type: "error" });
        });
    };
    loadContext();
    // The source visual can resolve after the editor opened (a favicon fetched
    // in the background); the history event announces it.
    const stopListening = subscribeDesktopEvent({
      event: "clipboard-history-changed",
      handler: loadContext,
      onError: () => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
          operation: DESKTOP_TELEMETRY_OPERATIONS.clipboardEditorRead,
          window: DESKTOP_TELEMETRY_WINDOWS.clipboardEditor,
        });
      },
    });
    return () => {
      disposed = true;
      stopListening();
    };
  }, [loadError]);

  const format = (command: FormatCommand) => {
    const editor = editorRef.current;
    if (editor && applyFormat(editor, command)) {
      editedRef.current = true;
    }
  };

  const save = () => {
    if (state.type !== "ready") {
      return;
    }
    const { item } = state.context;
    if (item.type === "image") {
      setState({
        context: state.context,
        groupId: state.groupId,
        save: { type: "saving" },
        type: "ready",
      });
      void invoke("clipboard_set_item_group", {
        groupId: state.groupId,
        id: item.id,
      })
        .then(closeEditor)
        .catch((error: unknown) => {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
            detail: describeError(error),
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
      return;
    }
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const plainText = editedRef.current
      ? editorPlainText(editor)
      : item.plainText;
    if (!plainText.trim()) {
      return;
    }
    let html: string | null = item.type === "formattedText" ? item.html : null;
    if (editedRef.current) {
      html = editor.innerHTML;
    }
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
      .catch((error: unknown) => {
        reportDesktopError({
          code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          detail: describeError(error),
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
    const primaryModifier = hasClipboardPrimaryModifier({
      altGraphKey: event.getModifierState("AltGraph"),
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
    if (primaryModifier && event.key === "Enter") {
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
  const sourceName = item.sourceApp
    ? clipboardSourceLabel(item.sourceApp)
    : null;
  const sourceTitle = item.sourceApp
    ? clipboardSourceTitle(item.sourceApp)
    : undefined;
  const sourceVisual = state.context.sourceAppVisual;
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
              className="text-muted-foreground flex min-w-0 items-center gap-1.5 truncate text-xs"
              data-tauri-drag-region
              title={sourceTitle}
            >
              {sourceVisual?.iconDataUrl ? (
                <ClipboardSourceIcon
                  iconDataUrl={sourceVisual.iconDataUrl}
                  kind={item.sourceApp?.page ? "favicon" : "app"}
                  size="inline"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="bg-muted-foreground/55 size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: sourceVisual?.color ?? undefined }}
                />
              )}
              <span className="truncate" dir="auto">
                {sourceName}
              </span>
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
        {item.type === "image" ? (
          <div className="bg-card ring-border flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-hidden rounded-[22px] p-5 ring-1 ring-inset">
            <div className="min-h-0 min-w-0 flex-1 self-stretch">
              <ClipboardImagePreview
                alt={item.name ?? t("image")}
                id={item.id}
                showRetry
                surface="editor"
              />
            </div>
            <div className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs tabular-nums">
              <bdi dir="auto">
                {t("imageDimensions", {
                  height: formatter.number(item.height),
                  width: formatter.number(item.width),
                })}
              </bdi>
              <span aria-hidden="true">·</span>
              <bdi dir="auto">
                {t("imageSize", {
                  size: formatter.number(item.byteSize, {
                    style: "unit",
                    unit: "byte",
                    unitDisplay: "short",
                  }),
                })}
              </bdi>
            </div>
          </div>
        ) : (
          <>
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
              onInput={() => {
                editedRef.current = true;
              }}
              ref={editorRef}
            />
          </>
        )}

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
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: group.color,
                      }}
                    />
                    <span dir="auto">{group.name}</span>
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
