import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

import { panic, Result } from "better-result";
import {
  Building2Icon,
  ChevronDownIcon,
  CopyIcon,
  HighlighterIcon,
  LockIcon,
  MessageSquarePlusIcon,
  SparklesIcon,
  StrikethroughIcon,
  Trash2Icon,
  UnderlineIcon,
  WavesIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import { MenuPreviewLayout, PreviewPane } from "@stll/ui/preview-pane";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  ANNOTATION_COLORS,
  ANNOTATION_STYLES,
} from "@/components/legal-reader/annotations/annotation-types";
import type {
  AnnotationColor,
  AnnotationStyle,
  AnnotationVisibility,
} from "@/components/legal-reader/annotations/annotation-types";
import {
  askAboutReaderPassage,
  readerSelectionLocator,
  readerSpansLocator,
  readerTargetCitation,
  writeReaderPassage,
} from "@/components/legal-reader/annotations/reader-annotation-target";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import {
  readerAnnotationActivationAction,
  readerSelectionContainmentAction,
  selectionAnchorsFrom,
} from "@/components/legal-reader/annotations/selection-anchor";
import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";
import type { ReaderAnnotationController } from "@/components/legal-reader/annotations/use-reader-annotations";
import Tooltip from "@/components/tooltip";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";

/** Room above the words for the bar, so it never covers what was selected. */
const BAR_OFFSET_PX = 44;
/** The least the bar keeps between itself and either window edge. */
const BAR_EDGE_MARGIN_PX = 8;

type AnnotationToolbarProps = {
  /** A mark the reader clicked; the bar edits it instead of the selection. */
  activeAnnotation: ReaderAnnotation | null;
  /** Every paragraph the clicked mark covers, for a comment on the passage. */
  activeSpans: readonly SelectionAnchor[];
  controller: ReaderAnnotationController;
  mode: "authenticated" | "guest";
  onClearActive: () => void;
  /** The reader clicked a mark in the text. */
  onActivateAnnotation: (id: string) => void;
  /** Opens the margin composer on these paragraphs. Absent on a reader with
   * no notes margin, where the bar offers no comment at all rather than an
   * affordance that leads nowhere. */
  onCompose?: ((spans: SelectionAnchor[]) => void) | undefined;
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** The document being marked: the only thing that differs by corpus. */
  target: ReaderAnnotationTarget;
};

type Selected = {
  rect: DOMRect;
  /** One per paragraph the selection touches; empty outside the words. */
  spans: SelectionAnchor[];
  text: string;
  /** The words alone: reader chrome, note marks and page markers removed —
   * what a quotation of the passage should contain. */
  cleanText: string;
  /** Where in the document the quotation sits: a reporter page in a
   * decision, a provision in a statute. Null where the document offers
   * neither. */
  locator: string | null;
};

type ReaderSelectionSnapshot = {
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
};

/** Chrome that must never leak into a quotation. */
const QUOTE_CHROME_SELECTOR = "[data-reader-chrome], .reader-note-ref";

const BLOCK_BOUNDARY_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote";

const cleanSelectionText = (range: Range): string => {
  const holder =
    range.startContainer.ownerDocument?.createElement("div") ?? null;
  if (holder === null) {
    return "";
  }
  holder.append(range.cloneContents());
  for (const el of holder.querySelectorAll(QUOTE_CHROME_SELECTOR)) {
    el.remove();
  }
  // textContent concatenates block elements without any separator, gluing
  // the last word of one paragraph to the first of the next; give each
  // block an explicit boundary before flattening.
  for (const block of holder.querySelectorAll(BLOCK_BOUNDARY_SELECTOR)) {
    block.append("\n");
  }
  return holder.textContent.replaceAll(/\s+/gu, " ").trim();
};

const COPY_MODES = [
  "quoteWithCitation",
  "citationWithQuote",
  "blockQuoteWithCitation",
  "textOnly",
  "citationOnly",
] as const;
type CopyMode = (typeof COPY_MODES)[number];

const copyTextFor = (
  mode: CopyMode,
  selected: Pick<Selected, "cleanText" | "locator">,
  target: ReaderAnnotationTarget,
): string => {
  const quote = selected.cleanText;
  const citation = readerTargetCitation({
    locator: selected.locator,
    target,
  });
  switch (mode) {
    case "quoteWithCitation": {
      return `“${quote}” ${citation}.`;
    }
    case "citationWithQuote": {
      return `${citation} (“${quote}”).`;
    }
    case "blockQuoteWithCitation": {
      return `${quote}\n\n${citation}.`;
    }
    case "textOnly": {
      return quote;
    }
    case "citationOnly": {
      return `${citation}.`;
    }
    default: {
      mode satisfies never;
      return panic(`Unhandled mode: ${String(mode)}`);
    }
  }
};

const STYLE_ICONS = {
  highlight: HighlighterIcon,
  underline: UnderlineIcon,
  squiggly: WavesIcon,
  strikethrough: StrikethroughIcon,
} as const satisfies Record<AnnotationStyle, unknown>;

/**
 * What a reader can do with selected words in a decision or a statute: send
 * them to the AI with the document attached, mark them in a colour and style,
 * or comment on them.
 * Floats over the selection the way a PDF reader's mark-up bar does, and
 * over a clicked mark to change or remove it.
 *
 * Every DOM access goes through the reader's own container, so the module
 * carries no browser global and renders nothing on the server.
 */
export const AnnotationToolbar = ({
  activeAnnotation,
  activeSpans,
  controller,
  mode,
  onActivateAnnotation,
  onClearActive,
  onCompose,
  scrollContainerRef,
  target,
}: AnnotationToolbarProps) => {
  const t = useTranslations();
  const barRef = useRef<HTMLDivElement | null>(null);
  // The bar's rendered width, learned from the node as React attaches it,
  // so the position can keep the whole bar inside the window.
  const [barWidth, setBarWidth] = useState(0);
  const attachBar = (node: HTMLDivElement | null) => {
    barRef.current = node;
    setBarWidth(node?.offsetWidth ?? 0);
  };
  const [selected, setSelected] = useState<Selected | null>(null);
  const [activeRect, setActiveRect] = useState<DOMRect | null>(null);
  // The reader's document, learned once mounted: the only browser handle the
  // bar holds, so nothing here reads a ref while rendering.
  const [doc, setDoc] = useState<Document | null>(null);
  const [style, setStyle] = useState<AnnotationStyle>("highlight");
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyPreviewMode, setCopyPreviewMode] = useState<CopyMode | null>(null);
  // The dropdown is hand-rolled (a portal menu would collapse the text
  // selection), so it does its own collision handling: open upward when
  // the space below the trigger cannot fit the menu.
  const [copyOpensUp, setCopyOpensUp] = useState(false);
  // A new highlight is private; sharing is a deliberate second step on the mark.
  const visibility: AnnotationVisibility = "private";

  // The listeners below are installed once, on mount, and the reader moves
  // between documents without remounting them: a listener that closed over
  // `target` would go on quoting and citing the document that was open when
  // it was installed. These read the latest one instead, so the bar cannot
  // hold a stale document at all.
  const locatorOf = useLatestCallback(
    (range: Range, root: HTMLElement, spans: readonly SelectionAnchor[]) =>
      readerSelectionLocator({ range, root, spans, target }),
  );
  const writePassage = useLatestCallback(
    (dataTransfer: DataTransfer, quote: string) =>
      writeReaderPassage({ dataTransfer, quote, target }),
  );
  const activateAnnotation = useLatestCallback(onActivateAnnotation);
  const clearActive = useLatestCallback(onClearActive);

  useMountEffect(() => {
    const root = scrollContainerRef.current;
    if (root === null) {
      return undefined;
    }
    const ownerDoc = root.ownerDocument;
    setDoc(ownerDoc);
    let frame = 0;
    let readerDragActive = false;
    let restoringReaderSelection = false;
    let readerSelectionSnapshot: ReaderSelectionSnapshot | null = null;
    const isInsideReader = (node: Node | null): boolean =>
      node !== null && root.contains(node);
    const isValidSelectionPoint = (node: Node, offset: number): boolean =>
      root.contains(node) &&
      offset <=
        (node instanceof CharacterData
          ? node.data.length
          : node.childNodes.length);
    const containReaderSelection = (selection: Selection): void => {
      if (restoringReaderSelection || selection.rangeCount === 0) {
        return;
      }
      const action = readerSelectionContainmentAction({
        anchor: isInsideReader(selection.anchorNode) ? "inside" : "outside",
        drag: readerDragActive ? "active" : "inactive",
        focus: isInsideReader(selection.focusNode) ? "inside" : "outside",
        snapshot: readerSelectionSnapshot === null ? "empty" : "available",
      });
      switch (action) {
        case "ignore":
          return;
        case "remember":
          if (selection.anchorNode === null || selection.focusNode === null) {
            return;
          }
          readerSelectionSnapshot = {
            anchorNode: selection.anchorNode,
            anchorOffset: selection.anchorOffset,
            focusNode: selection.focusNode,
            focusOffset: selection.focusOffset,
          };
          return;
        case "restore": {
          if (
            readerSelectionSnapshot === null ||
            !isValidSelectionPoint(
              readerSelectionSnapshot.anchorNode,
              readerSelectionSnapshot.anchorOffset,
            ) ||
            !isValidSelectionPoint(
              readerSelectionSnapshot.focusNode,
              readerSelectionSnapshot.focusOffset,
            )
          ) {
            readerSelectionSnapshot = null;
            return;
          }
          restoringReaderSelection = true;
          selection.setBaseAndExtent(
            readerSelectionSnapshot.anchorNode,
            readerSelectionSnapshot.anchorOffset,
            readerSelectionSnapshot.focusNode,
            readerSelectionSnapshot.focusOffset,
          );
          restoringReaderSelection = false;
          return;
        }
        default: {
          action satisfies never;
          return panic(`Unhandled selection action: ${String(action)}`);
        }
      }
    };
    const readSelection = () => {
      const currentSelection = ownerDoc.getSelection();
      if (currentSelection !== null) {
        containReaderSelection(currentSelection);
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const selection = ownerDoc.getSelection();
        if (
          selection === null ||
          selection.isCollapsed ||
          selection.rangeCount === 0 ||
          !root.contains(selection.anchorNode) ||
          barRef.current?.contains(selection.anchorNode) === true
        ) {
          setSelected(null);
          return;
        }
        const text = selection.toString().replace(/\s+/gu, " ").trim();
        if (text === "") {
          setSelected(null);
          return;
        }
        // A fresh selection must not inherit the previous one's open menu.
        setCopyOpen(false);
        const range = selection.getRangeAt(0);
        const cleanText = cleanSelectionText(range);
        const spans = selectionAnchorsFrom(selection, root);
        setSelected({
          cleanText: cleanText === "" ? text : cleanText,
          locator: locatorOf(range, root, spans),
          rect: range.getBoundingClientRect(),
          spans,
          text,
        });
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearActive();
        ownerDoc.getSelection()?.removeAllRanges();
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      const element = event.target instanceof Element ? event.target : null;
      const mark = element?.closest("[data-annotation-id]") ?? null;
      const id =
        mark instanceof HTMLElement
          ? (mark.dataset["annotationId"] ?? null)
          : null;
      if (mark !== null && id !== null && root.contains(mark)) {
        event.preventDefault();
        activateAnnotation(id);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const pressed = event.target;
      readerDragActive =
        event.button === 0 && pressed instanceof Node && root.contains(pressed);
      readerSelectionSnapshot = null;
      if (!(pressed instanceof Node) || barRef.current?.contains(pressed)) {
        return;
      }
      clearActive();
    };
    const onClick = (event: MouseEvent) => {
      const clicked = event.target;
      let element: Element | null = null;
      if (clicked instanceof Element) {
        element = clicked;
      } else if (
        clicked instanceof Node &&
        clicked.parentElement instanceof Element
      ) {
        element = clicked.parentElement;
      }
      const mark =
        element?.closest<HTMLElement>("[data-annotation-id]") ?? null;
      const id = mark?.dataset["annotationId"];
      if (mark === null || id === undefined || !root.contains(mark)) {
        return;
      }
      const selection = ownerDoc.getSelection();
      const action = readerAnnotationActivationAction({
        selection:
          selection === null || selection.isCollapsed ? "collapsed" : "range",
        target: "annotation",
      });
      if (action === "activate") {
        activateAnnotation(id);
      }
    };
    const onPointerEnd = () => {
      readerDragActive = false;
      readerSelectionSnapshot = null;
    };
    // Dragging selected words carries the passage with the document it came
    // from, so a drop on the chat composer lands as chips where the corpus
    // offers a reference for it.
    const onDragStart = (event: DragEvent) => {
      const selection = ownerDoc.getSelection();
      const quote = selection?.toString().replace(/\s+/gu, " ").trim() ?? "";
      if (
        event.dataTransfer === null ||
        selection === null ||
        quote === "" ||
        !root.contains(selection.anchorNode)
      ) {
        return;
      }
      writePassage(event.dataTransfer, quote);
    };
    ownerDoc.addEventListener("selectionchange", readSelection);
    ownerDoc.addEventListener("keydown", onKeyDown);
    ownerDoc.addEventListener("pointerdown", onPointerDown);
    ownerDoc.addEventListener("pointercancel", onPointerEnd);
    ownerDoc.addEventListener("pointerup", onPointerEnd);
    root.addEventListener("click", onClick);
    root.addEventListener("dragstart", onDragStart);
    return () => {
      cancelAnimationFrame(frame);
      ownerDoc.removeEventListener("selectionchange", readSelection);
      ownerDoc.removeEventListener("keydown", onKeyDown);
      ownerDoc.removeEventListener("pointerdown", onPointerDown);
      ownerDoc.removeEventListener("pointercancel", onPointerEnd);
      ownerDoc.removeEventListener("pointerup", onPointerEnd);
      root.removeEventListener("click", onClick);
      root.removeEventListener("dragstart", onDragStart);
    };
  });

  // The clicked mark's place on screen, read once per activation: a ref is
  // not for rendering, and the mark does not move while the bar is open.
  const activeAnnotationId = activeAnnotation?.id ?? null;
  useExternalSyncEffect(() => {
    if (activeAnnotationId === null) {
      setActiveRect(null);
      return;
    }
    const element = scrollContainerRef.current?.querySelector(
      `[data-annotation-id="${CSS.escape(activeAnnotationId)}"]`,
    );
    setActiveRect(element?.getBoundingClientRect() ?? null);
  }, [activeAnnotationId, scrollContainerRef]);

  const clearSelection = () => {
    doc?.getSelection()?.removeAllRanges();
    setSelected(null);
  };

  // A statute consolidation is not a reference the chat's corpus tools take,
  // so the passage reaches them as a question naming the document. It carries
  // the passage's own locator, which for a statute is the provision: a
  // question about "the act" and a question about "§ 2079 of the act" are not
  // the same question, and the tools look the provision up by it.
  const askAboutPassage = (quote: string, locator: string | null) => {
    askAboutReaderPassage({
      prompt: t("legalReader.annotations.askPassagePrompt", {
        citation: readerTargetCitation({ locator, target }),
        quote,
      }),
      quote,
      target,
    });
  };

  const createHighlight = (
    spans: SelectionAnchor[],
    color: AnnotationColor,
  ) => {
    detached(
      controller.create({
        color,
        spans,
        kind: "highlight",
        style,
        visibility,
      }),
      "legal-reader.annotation-highlight",
    );
    clearSelection();
  };

  const rect = activeRect ?? selected?.rect ?? null;
  if (rect === null) {
    return null;
  }

  // Centred on the selection, then held inside the window: a selection near
  // the edge of a narrow inspector pane would otherwise put half the bar off
  // screen. The bar's own width is known once it is on screen; until then
  // the centre stands, and the measure re-renders it into place.
  const viewportWidth =
    doc?.defaultView?.innerWidth ?? Number.POSITIVE_INFINITY;
  const halfBar = barWidth / 2;
  const centred = rect.left + rect.width / 2;
  const position = {
    left: Math.max(
      BAR_EDGE_MARGIN_PX + halfBar,
      Math.min(centred, viewportWidth - BAR_EDGE_MARGIN_PX - halfBar),
    ),
    top: Math.max(8, rect.top - BAR_OFFSET_PX),
  };

  const colorSwatches = (onPick: (color: AnnotationColor) => void) =>
    ANNOTATION_COLORS.map((color) => (
      <Tooltip
        content={t(colorLabelKey(color))}
        key={color}
        render={
          <button
            aria-label={t(colorLabelKey(color))}
            className="focus-visible:ring-ring size-4 rounded-full ring-offset-1 transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:outline-none"
            onClick={() => onPick(color)}
            style={{ backgroundColor: `var(--option-${color})` }}
            type="button"
          />
        }
      />
    ));

  const styleButtons = (
    current: AnnotationStyle,
    onPick: (style: AnnotationStyle) => void,
  ) =>
    ANNOTATION_STYLES.map((option) => {
      const Icon = STYLE_ICONS[option];
      return (
        <Tooltip
          content={t(styleLabelKey(option))}
          key={option}
          render={
            <Button
              aria-label={t(styleLabelKey(option))}
              aria-pressed={current === option}
              className={cn(current === option && "bg-accent text-foreground")}
              onClick={() => onPick(option)}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <Icon className="size-3.5" />
        </Tooltip>
      );
    });

  let content: ReactNode;
  if (activeAnnotation !== null) {
    if (!activeAnnotation.mine) {
      content = (
        <div className="flex items-center gap-1">
          <Button
            onClick={() => {
              askAboutPassage(
                activeSpans.map((span) => span.quote).join(" "),
                readerSpansLocator({ spans: activeSpans, target }),
              );
              onClearActive();
            }}
            size="sm"
            variant="ghost"
          >
            <SparklesIcon className="size-3.5" />
            {t("common.askAI")}
          </Button>
        </div>
      );
    } else {
      const removeLabel =
        activeAnnotation.kind === "highlight"
          ? t("legalReader.annotations.removeHighlight")
          : t("common.delete");
      content = (
        <div className="flex items-center gap-1">
          {activeAnnotation.kind === "highlight" && (
            <>
              {styleButtons(activeAnnotation.style ?? "highlight", (next) => {
                detached(
                  controller.update({
                    change: "style",
                    id: activeAnnotation.id,
                    style: next,
                  }),
                  "legal-reader.annotation-restyle",
                );
              })}
              <span className="bg-border mx-1 h-4 w-px" />
              <div className="flex items-center gap-1.5 px-1">
                {colorSwatches((color) => {
                  detached(
                    controller.update({
                      change: "color",
                      color,
                      id: activeAnnotation.id,
                    }),
                    "legal-reader.annotation-recolor",
                  );
                })}
              </div>
              <span className="bg-border mx-1 h-4 w-px" />
            </>
          )}
          {activeAnnotation.kind === "highlight" && onCompose !== undefined && (
            <>
              <Button
                onClick={() => {
                  onCompose(
                    activeSpans.map((span) => ({
                      blockAnchorId: span.blockAnchorId,
                      endOffset: span.endOffset,
                      quote: span.quote,
                      startOffset: span.startOffset,
                    })),
                  );
                  onClearActive();
                }}
                size="sm"
                variant="ghost"
              >
                <MessageSquarePlusIcon className="size-3.5" />
                {t("folio.comment")}
              </Button>
              <span className="bg-border mx-1 h-4 w-px" />
            </>
          )}
          {mode === "authenticated" && (
            <VisibilityToggle
              onChange={(next) => {
                detached(
                  controller.update({
                    change: "visibility",
                    id: activeAnnotation.id,
                    visibility: next,
                  }),
                  "legal-reader.annotation-visibility",
                );
              }}
              value={activeAnnotation.visibility}
            />
          )}
          <Tooltip
            content={removeLabel}
            render={
              <Button
                aria-label={removeLabel}
                className="hover:text-destructive"
                onClick={() => {
                  detached(
                    controller.remove(activeAnnotation.id),
                    "legal-reader.annotation-remove",
                  );
                  onClearActive();
                }}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <Trash2Icon className="size-3.5" />
          </Tooltip>
        </div>
      );
    }
  } else if (selected !== null) {
    const spans = selected.spans;
    content = (
      <div className="flex items-center gap-1">
        <div className="relative">
          <Button
            onClick={(event) => {
              const MENU_ESTIMATED_HEIGHT_PX = 200;
              const triggerRect = event.currentTarget.getBoundingClientRect();
              const viewportHeight =
                event.currentTarget.ownerDocument.defaultView?.innerHeight ?? 0;
              setCopyOpensUp(
                triggerRect.bottom + MENU_ESTIMATED_HEIGHT_PX > viewportHeight,
              );
              setCopyPreviewMode(null);
              setCopyOpen((open) => !open);
            }}
            onMouseDown={(event) => event.preventDefault()}
            size="sm"
            variant="ghost"
          >
            <CopyIcon className="size-3.5" />
            {t("common.copy")}
            <ChevronDownIcon className="size-3" />
          </Button>
          {copyOpen && (
            <div
              className={cn(
                "bg-popover text-popover-foreground absolute start-0 z-10 rounded-md border p-1 shadow-md",
                copyOpensUp ? "bottom-full mb-1" : "top-full mt-1",
              )}
            >
              <MenuPreviewLayout
                preview={
                  // The submenu paints over the pane rather than in it, so its
                  // floor is the viewport's, not the pane's.
                  <PreviewPane className="w-[min(18rem,calc(100vw-9rem))]">
                    {copyPreviewMode !== null && (
                      <p className="text-foreground text-2xs leading-snug whitespace-pre-wrap">
                        {copyTextFor(
                          copyPreviewMode,
                          {
                            cleanText:
                              selected.cleanText.length > 220
                                ? `${selected.cleanText.slice(0, 220)}…`
                                : selected.cleanText,
                            locator: selected.locator,
                          },
                          target,
                        )}
                      </p>
                    )}
                  </PreviewPane>
                }
              >
                {COPY_MODES.map((copyMode) => (
                  <button
                    className="hover:bg-accent block w-full rounded-sm px-2 py-1.5 text-start text-xs whitespace-nowrap"
                    key={copyMode}
                    onClick={() => {
                      const text = copyTextFor(copyMode, selected, target);
                      detached(
                        (async () => {
                          const copied = await copyToClipboard(text);
                          if (Result.isError(copied)) {
                            stellaToast.add({
                              title: t("errors.actionFailed"),
                              type: "error",
                            });
                            return;
                          }
                          stellaToast.add({
                            title: t("common.copied"),
                            type: "success",
                          });
                        })(),
                        "legal-reader.selection-copy",
                      );
                      setCopyOpen(false);
                      clearSelection();
                    }}
                    onFocus={() => setCopyPreviewMode(copyMode)}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setCopyPreviewMode(copyMode)}
                    type="button"
                  >
                    {t(`legalReader.copyMenu.${copyMode}`)}
                  </button>
                ))}
              </MenuPreviewLayout>
            </div>
          )}
        </div>
        {mode === "authenticated" && (
          <>
            <span className="bg-border mx-1 h-4 w-px" />
            <Button
              onClick={() => {
                askAboutPassage(selected.text, selected.locator);
                clearSelection();
              }}
              size="sm"
              variant="ghost"
            >
              <SparklesIcon className="size-3.5" />
              {t("common.askAI")}
            </Button>
          </>
        )}
        {spans.length > 0 && (
          <>
            <span className="bg-border mx-1 h-4 w-px" />
            {styleButtons(style, setStyle)}
            <div className="flex items-center gap-1.5 px-1">
              {colorSwatches((color) => createHighlight(spans, color))}
            </div>
            {onCompose !== undefined && (
              <>
                <span className="bg-border mx-1 h-4 w-px" />
                <Button
                  onClick={() => {
                    onCompose(spans);
                    clearSelection();
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <MessageSquarePlusIcon className="size-3.5" />
                  {t("folio.comment")}
                </Button>
              </>
            )}
          </>
        )}
      </div>
    );
  } else {
    return null;
  }

  const host = doc?.body ?? null;
  if (host === null) {
    return null;
  }

  return createPortal(
    <div
      className="reader-chrome bg-popover text-popover-foreground fixed z-[100] max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-md border p-1 text-xs shadow-md"
      ref={attachBar}
      style={position}
    >
      {content}
    </div>,
    host,
  );
};

const VisibilityToggle = ({
  onChange,
  value,
}: {
  onChange: (next: AnnotationVisibility) => void;
  value: AnnotationVisibility;
}) => {
  const t = useTranslations();
  const shared = value === "shared";
  const label = shared
    ? t("legalReader.annotations.visibilityShared")
    : t("knowledge.agentSkills.scopePrivate");

  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          aria-pressed={shared}
          className="text-2xs gap-1 px-1.5"
          onClick={() => onChange(shared ? "private" : "shared")}
          size="sm"
          variant="ghost"
        />
      }
    >
      {shared ? (
        <Building2Icon className="size-3.5" />
      ) : (
        <LockIcon className="size-3.5" />
      )}
      {label}
    </Tooltip>
  );
};

const colorLabelKey = (color: AnnotationColor) => {
  switch (color) {
    case "yellow": {
      return "legalReader.annotations.colorYellow" as const;
    }
    case "green": {
      return "legalReader.annotations.colorGreen" as const;
    }
    case "sky": {
      return "legalReader.annotations.colorSky" as const;
    }
    case "violet": {
      return "legalReader.annotations.colorViolet" as const;
    }
    case "red": {
      return "legalReader.annotations.colorRed" as const;
    }
    default: {
      color satisfies never;
      return panic(`Unhandled color: ${String(color)}`);
    }
  }
};

const styleLabelKey = (style: AnnotationStyle) => {
  switch (style) {
    case "highlight": {
      return "legalReader.annotations.styleHighlight" as const;
    }
    case "underline": {
      return "folio.underline" as const;
    }
    case "squiggly": {
      return "legalReader.annotations.styleSquiggly" as const;
    }
    case "strikethrough": {
      return "legalReader.annotations.styleStrikethrough" as const;
    }
    default: {
      style satisfies never;
      return panic(`Unhandled style: ${String(style)}`);
    }
  }
};
