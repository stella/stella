import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { AddCommentIcon, SparklesIcon, Trash2Icon } from "@stll/ui/icons";

import type {
  AnnotationColor,
  AnnotationStyle,
  AnnotationVisibility,
} from "@/components/legal-reader/annotations/annotation-types";
import {
  askAboutReaderPassage,
  readerSelectionLocator,
  readerSpansLocator,
  writeReaderPassage,
} from "@/components/legal-reader/annotations/reader-annotation-target";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import {
  cleanSelectionText,
  copyTextFor,
  readerTargetCitation,
} from "@/components/legal-reader/annotations/reader-copy-text.logic";
import {
  readerAnnotationActivationAction,
  readerSelectionContainmentAction,
  selectionAnchorsFrom,
} from "@/components/legal-reader/annotations/selection-anchor";
import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";
import type { ReaderAnnotationController } from "@/components/legal-reader/annotations/use-reader-annotation-history";
import { useReaderAnnotationShortcuts } from "@/components/legal-reader/annotations/use-reader-annotation-shortcuts";
import { SelectionToolbar } from "@/components/selection-toolbar";
import {
  SelectionAIActions,
  SelectionCopyMenu,
  useSelectionCopy,
} from "@/components/selection-toolbar-actions";
import {
  MarkColorSwatches,
  MarkStyleButtons,
  MarkVisibilityToggle,
} from "@/components/selection-toolbar-marks";
import {
  scrollMovesSelection,
  selectionToolbarAnchor,
} from "@/components/selection-toolbar.logic";
import Tooltip from "@/components/tooltip";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";

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
  onExplain?: ((spans: SelectionAnchor[]) => void) | undefined;
  /** Why Explain cannot take these spans, or `undefined` when it can. */
  explainRefusal?:
    ((spans: SelectionAnchor[]) => string | undefined) | undefined;
  /** The paragraphs the settled selection covers, on the same frame the bar
   * reads them; empty once nothing is selected. Called again on scroll and
   * resize with the same spans, so a consumer compares before it stores. */
  onSelectedSpansChange?:
    ((spans: readonly SelectionAnchor[]) => void) | undefined;
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** The document being marked: the only thing that differs by corpus. */
  target: ReaderAnnotationTarget;
};

type Selected = {
  rect: DOMRect;
  bounds: DOMRect;
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

const NO_SELECTED_SPANS: readonly SelectionAnchor[] = [];

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
  onExplain,
  explainRefusal,
  onSelectedSpansChange,
  scrollContainerRef,
  target,
}: AnnotationToolbarProps) => {
  const t = useTranslations();
  const barRef = useRef<HTMLDivElement | null>(null);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);
  const attachBar = (node: HTMLDivElement | null) => {
    barRef.current = node;
  };
  const [selected, setSelected] = useState<Selected | null>(null);
  const [activeGeometry, setActiveGeometry] =
    useState<ReturnType<typeof selectionToolbarAnchor>>(null);
  // The reader's document, learned once mounted: the only browser handle the
  // bar holds, so nothing here reads a ref while rendering.
  const [doc, setDoc] = useState<Document | null>(null);
  const [style, setStyle] = useState<AnnotationStyle>("highlight");
  const [copyOpen, setCopyOpen] = useState(false);
  const selectionCopy = useSelectionCopy();
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
  const reportSelectedSpans = useLatestCallback(
    (spans: readonly SelectionAnchor[]) => onSelectedSpansChange?.(spans),
  );

  useReaderAnnotationShortcuts({
    onRedo: controller.redo,
    onUndo: controller.undo,
    scrollContainerRef,
    surfaceRefs: [barRef, copyMenuRef],
  });

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
    // The bar appears once a pointer drag ends. Painting it mid-drag puts a
    // fixed element, portalled after the reader, under the pointer: crossing
    // it extends the selection to the end of the page for a frame. It also
    // anchors to the selection's end in every phase, so it does not move
    // between the drag, the release and a later scroll.
    const readSelection = () => {
      const currentSelection = ownerDoc.getSelection();
      if (currentSelection !== null) {
        containReaderSelection(currentSelection);
      }
      cancelAnimationFrame(frame);
      if (readerDragActive) {
        setSelected(null);
        return;
      }
      frame = requestAnimationFrame(() => {
        const selection = ownerDoc.getSelection();
        if (
          readerDragActive ||
          selection === null ||
          selection.isCollapsed ||
          selection.rangeCount === 0 ||
          !root.contains(selection.anchorNode) ||
          barRef.current?.contains(selection.anchorNode) === true
        ) {
          setSelected(null);
          reportSelectedSpans(NO_SELECTED_SPANS);
          return;
        }
        const text = selection.toString().replace(/\s+/gu, " ").trim();
        if (text === "") {
          setSelected(null);
          reportSelectedSpans(NO_SELECTED_SPANS);
          return;
        }
        // A fresh selection must not inherit the previous one's open menu.
        setCopyOpen(false);
        const range = selection.getRangeAt(0);
        const spans = selectionAnchorsFrom(selection, root);
        // Reported before the bar's geometry: words scrolled out of view are
        // still selected, though the bar has nowhere to float.
        reportSelectedSpans(spans);
        const geometry = selectionToolbarAnchor({ range, root });
        if (geometry === null) {
          setSelected(null);
          return;
        }
        const cleanText = cleanSelectionText(range);
        setSelected({
          cleanText: cleanText === "" ? text : cleanText,
          locator: locatorOf(range, root, spans),
          rect: geometry.rect,
          bounds: geometry.bounds,
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
      if (
        !(pressed instanceof Node) ||
        barRef.current?.contains(pressed) ||
        copyMenuRef.current?.contains(pressed)
      ) {
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
    const onPointerCancel = () => {
      readerDragActive = false;
      readerSelectionSnapshot = null;
    };
    const onPointerEnd = (event: PointerEvent) => {
      onPointerCancel();
      if (
        event.target instanceof Node &&
        (barRef.current?.contains(event.target) ||
          copyMenuRef.current?.contains(event.target))
      ) {
        return;
      }
      readSelection();
    };
    const onSelectionChange = () => {
      selectionCopy.selectionChanged();
      readSelection();
    };
    const onCopy = () => {
      const selection = ownerDoc.getSelection();
      if (
        barRef.current !== null &&
        selection !== null &&
        !selection.isCollapsed &&
        root.contains(selection.anchorNode) &&
        root.contains(selection.focusNode)
      ) {
        selectionCopy.confirmNativeCopy();
      }
    };
    const onViewportChange = () => readSelection();
    const onScroll = (event: Event) => {
      if (scrollMovesSelection(event, [barRef.current, copyMenuRef.current])) {
        readSelection();
      }
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
    ownerDoc.addEventListener("selectionchange", onSelectionChange);
    ownerDoc.addEventListener("copy", onCopy);
    ownerDoc.addEventListener("keydown", onKeyDown);
    ownerDoc.addEventListener("pointerdown", onPointerDown);
    ownerDoc.addEventListener("pointercancel", onPointerCancel);
    ownerDoc.addEventListener("pointerup", onPointerEnd);
    ownerDoc.addEventListener("scroll", onScroll, true);
    ownerDoc.defaultView?.addEventListener("resize", onViewportChange);
    const observer = new ResizeObserver(onViewportChange);
    observer.observe(root);
    root.addEventListener("click", onClick);
    root.addEventListener("dragstart", onDragStart);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      ownerDoc.removeEventListener("selectionchange", onSelectionChange);
      ownerDoc.removeEventListener("copy", onCopy);
      ownerDoc.removeEventListener("keydown", onKeyDown);
      ownerDoc.removeEventListener("pointerdown", onPointerDown);
      ownerDoc.removeEventListener("pointercancel", onPointerCancel);
      ownerDoc.removeEventListener("pointerup", onPointerEnd);
      ownerDoc.removeEventListener("scroll", onScroll, true);
      ownerDoc.defaultView?.removeEventListener("resize", onViewportChange);
      root.removeEventListener("click", onClick);
      root.removeEventListener("dragstart", onDragStart);
    };
  });

  // A mark follows its visible words when this reader or an ancestor scrolls.
  const activeAnnotationId = activeAnnotation?.id ?? null;
  useExternalSyncEffect(() => {
    const root = scrollContainerRef.current;
    if (activeAnnotationId === null || root === null) {
      setActiveGeometry(null);
      return undefined;
    }
    const updateGeometry = () => {
      const element = root.querySelector(
        `[data-annotation-id="${CSS.escape(activeAnnotationId)}"]`,
      );
      if (element === null) {
        setActiveGeometry(null);
        return;
      }
      const range = root.ownerDocument.createRange();
      range.selectNodeContents(element);
      setActiveGeometry(selectionToolbarAnchor({ range, root }));
    };
    const ownerDoc = root.ownerDocument;
    updateGeometry();
    ownerDoc.addEventListener("scroll", updateGeometry, true);
    ownerDoc.defaultView?.addEventListener("resize", updateGeometry);
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(root);
    return () => {
      observer.disconnect();
      ownerDoc.removeEventListener("scroll", updateGeometry, true);
      ownerDoc.defaultView?.removeEventListener("resize", updateGeometry);
    };
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
        citation: readerTargetCitation({ locator, target }).inline,
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

  const geometry = activeAnnotation !== null ? activeGeometry : selected;
  if (geometry === null) {
    return null;
  }

  let content: ReactNode;
  if (activeAnnotation !== null) {
    if (!activeAnnotation.mine) {
      content = (
        <div className="flex flex-wrap items-center gap-1">
          <CapabilityAction action={{ capability: "ai" }} surface="control">
            {(capabilityProps) => (
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
                {...capabilityProps}
              >
                <SparklesIcon className="size-3.5" />
                {t("common.askAI")}
              </Button>
            )}
          </CapabilityAction>
        </div>
      );
    } else {
      const removeLabel =
        activeAnnotation.kind === "highlight"
          ? t("legalReader.annotations.removeHighlight")
          : t("common.delete");
      content = (
        <div className="flex flex-wrap items-center gap-1">
          {activeAnnotation.kind === "highlight" && (
            <>
              <MarkStyleButtons
                current={activeAnnotation.style ?? "highlight"}
                onPick={(next) => {
                  detached(
                    controller.update({
                      change: "style",
                      id: activeAnnotation.id,
                      style: next,
                    }),
                    "legal-reader.annotation-restyle",
                  );
                }}
              />
              <span className="bg-border mx-1 h-4 w-px" />
              <div className="flex items-center gap-1.5 px-1">
                <MarkColorSwatches
                  onPick={(color) => {
                    detached(
                      controller.update({
                        change: "color",
                        color,
                        id: activeAnnotation.id,
                      }),
                      "legal-reader.annotation-recolor",
                    );
                  }}
                />
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
                <AddCommentIcon className="size-3.5" />
                {t("folio.comment")}
              </Button>
              <span className="bg-border mx-1 h-4 w-px" />
            </>
          )}
          {mode === "authenticated" && (
            <MarkVisibilityToggle
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
              sharedLabel={t("legalReader.annotations.visibilityShared")}
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
      <div className="flex flex-wrap items-center gap-1">
        <SelectionCopyMenu
          barRef={barRef}
          copy={selectionCopy}
          doc={doc}
          menuRef={copyMenuRef}
          onOpenChange={setCopyOpen}
          open={copyOpen}
          quote={selected.cleanText}
          textFor={(copyMode, quote) =>
            copyTextFor({
              mode: copyMode,
              selected: { cleanText: quote, locator: selected.locator },
              target,
            })
          }
        />
        {/* AI actions take the document's own words only: a selection with no
            anchored text (AI notes, reader chrome) is not offered to them,
            and the passage sent is the anchored words, never the chrome or
            generated text a drag also crossed. */}
        {mode === "authenticated" && spans.length > 0 && (
          <SelectionAIActions
            explainRefusal={explainRefusal?.(spans)}
            onAsk={() => {
              askAboutPassage(
                spans.map(({ quote }) => quote).join(" "),
                selected.locator,
              );
              clearSelection();
            }}
            onExplain={
              onExplain === undefined
                ? undefined
                : () => {
                    onExplain(spans);
                    clearSelection();
                  }
            }
          />
        )}
        {spans.length > 0 && (
          <>
            <span className="bg-border mx-1 h-4 w-px" />
            <MarkStyleButtons current={style} onPick={setStyle} />
            <div className="flex items-center gap-1.5 px-1">
              <MarkColorSwatches
                onPick={(color) => createHighlight(spans, color)}
              />
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
                  <AddCommentIcon className="size-3.5" />
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

  return (
    <SelectionToolbar
      anchorRect={geometry.rect}
      boundaryRect={geometry.bounds}
      className="reader-chrome"
      doc={doc}
      onAttach={attachBar}
    >
      {content}
    </SelectionToolbar>
  );
};
