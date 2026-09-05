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

import { writeDecisionPassage } from "@/components/chat-decision-passage";
import Tooltip from "@/components/tooltip";
import { askAboutSelection } from "@/features/case-law/annotations/ask-about-selection";
import { selectionAnchorsFrom } from "@/features/case-law/annotations/selection-anchor";
import type { SelectionAnchor } from "@/features/case-law/annotations/selection-anchor";
import {
  ANNOTATION_COLORS,
  ANNOTATION_STYLES,
} from "@/features/case-law/annotations/use-decision-annotations";
import type {
  AnnotationColor,
  AnnotationStyle,
  AnnotationVisibility,
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/features/case-law/annotations/use-decision-annotations";
import { formatDecisionCitation } from "@/features/case-law/citation-format";
import type { DecisionAnnotation } from "@/features/case-law/queries/annotations";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";

/** Room above the words for the bar, so it never covers what was selected. */
const BAR_OFFSET_PX = 44;

export type AnnotationToolbarDecision = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: Date | string | null;
  decisionType: string | null;
  ecli: string | null;
  id: string;
  /** Citable case name ("Brown v. Board of Education"); null when the
   * document does not state one. */
  name: string | null;
};

export type AnnotationToolbarController = {
  create: (input: CreateAnnotationInput) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  update: (input: UpdateAnnotationInput) => Promise<unknown>;
};

type AnnotationToolbarProps = {
  /** A mark the reader clicked; the bar edits it instead of the selection. */
  activeAnnotation: DecisionAnnotation | null;
  /** Every paragraph the clicked mark covers, for a comment on the passage. */
  activeSpans: readonly SelectionAnchor[];
  controller: AnnotationToolbarController;
  decision: AnnotationToolbarDecision;
  onClearActive: () => void;
  /** The reader clicked a mark in the text. */
  onActivateAnnotation: (id: string) => void;
  /** Opens the margin composer on these paragraphs. */
  onCompose: (spans: SelectionAnchor[]) => void;
  scrollContainerRef: RefObject<HTMLElement | null>;
};

type Selected = {
  rect: DOMRect;
  /** One per paragraph the selection touches; empty outside the words. */
  spans: SelectionAnchor[];
  text: string;
  /** The words alone: reader chrome, note marks and page markers removed —
   * what a quotation of the passage should contain. */
  cleanText: string;
  /** Reporter page the selection starts on, from the last page marker
   * before it; null before the first marker or in unpaginated documents. */
  pincite: string | null;
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

const pinciteOf = (root: HTMLElement, range: Range): string | null => {
  let last: string | null = null;
  for (const marker of root.querySelectorAll(".reader-page-marker")) {
    // -1: the marker sits before the selection's start.
    if (range.comparePoint(marker, 0) !== -1) {
      continue;
    }
    const digits = /\d+/u.exec(marker.textContent)?.[0];
    if (digits !== undefined) {
      last = digits;
    }
  }
  return last;
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
  selected: Pick<Selected, "cleanText" | "pincite">,
  decision: AnnotationToolbarDecision,
): string => {
  const quote = selected.cleanText;
  const citation = formatDecisionCitation({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType,
    ecli: decision.ecli,
    name: decision.name,
    pincite: selected.pincite,
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
 * What a reader can do with selected words: send them to the AI with the
 * decision attached, mark them in a colour and style, or comment on them.
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
  decision,
  onActivateAnnotation,
  onClearActive,
  onCompose,
  scrollContainerRef,
}: AnnotationToolbarProps) => {
  const t = useTranslations();
  const barRef = useRef<HTMLDivElement>(null);
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

  useMountEffect(() => {
    const root = scrollContainerRef.current;
    if (root === null) {
      return undefined;
    }
    const ownerDoc = root.ownerDocument;
    setDoc(ownerDoc);
    let frame = 0;
    const readSelection = () => {
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
        setSelected({
          cleanText: cleanText === "" ? text : cleanText,
          pincite: pinciteOf(root, range),
          rect: range.getBoundingClientRect(),
          spans: selectionAnchorsFrom(selection, root),
          text,
        });
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClearActive();
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
        onActivateAnnotation(id);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || barRef.current?.contains(target)) {
        return;
      }
      let element: Element | null = null;
      if (target instanceof Element) {
        element = target;
      } else if (target.parentNode instanceof Element) {
        element = target.parentNode;
      }
      const mark = element?.closest("[data-annotation-id]") ?? null;
      const id =
        mark instanceof HTMLElement
          ? (mark.dataset["annotationId"] ?? null)
          : null;
      if (mark !== null && id !== null && root.contains(mark)) {
        onActivateAnnotation(id);
        return;
      }
      onClearActive();
    };
    // Dragging selected words carries the passage with its decision, so a
    // drop on the chat composer lands as chips rather than loose text.
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
      writeDecisionPassage(event.dataTransfer, {
        caseNumber: decision.caseNumber,
        court: decision.court,
        decisionId: decision.id,
        quote,
      });
    };
    ownerDoc.addEventListener("selectionchange", readSelection);
    ownerDoc.addEventListener("keydown", onKeyDown);
    ownerDoc.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("dragstart", onDragStart);
    return () => {
      cancelAnimationFrame(frame);
      ownerDoc.removeEventListener("selectionchange", readSelection);
      ownerDoc.removeEventListener("keydown", onKeyDown);
      ownerDoc.removeEventListener("pointerdown", onPointerDown);
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
      "case-law.annotation-highlight",
    );
    clearSelection();
  };

  const rect = activeRect ?? selected?.rect ?? null;
  if (rect === null) {
    return null;
  }

  const position = {
    left: rect.left + rect.width / 2,
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
              askAboutSelection({
                caseNumber: decision.caseNumber,
                court: decision.court,
                decisionId: decision.id,
                quote: activeSpans.map((span) => span.quote).join(" "),
              });
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
          ? t("caseLaw.annotations.removeHighlight")
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
                  "case-law.annotation-restyle",
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
                    "case-law.annotation-recolor",
                  );
                })}
              </div>
              <span className="bg-border mx-1 h-4 w-px" />
            </>
          )}
          {activeAnnotation.kind === "highlight" && (
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
          <VisibilityToggle
            onChange={(next) => {
              detached(
                controller.update({
                  change: "visibility",
                  id: activeAnnotation.id,
                  visibility: next,
                }),
                "case-law.annotation-visibility",
              );
            }}
            value={activeAnnotation.visibility}
          />
          <Tooltip
            content={removeLabel}
            render={
              <Button
                aria-label={removeLabel}
                className="hover:text-destructive"
                onClick={() => {
                  detached(
                    controller.remove(activeAnnotation.id),
                    "case-law.annotation-remove",
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
                  <PreviewPane className="w-72">
                    {copyPreviewMode !== null && (
                      <p className="text-foreground text-[0.7rem] leading-snug whitespace-pre-wrap">
                        {copyTextFor(
                          copyPreviewMode,
                          {
                            cleanText:
                              selected.cleanText.length > 220
                                ? `${selected.cleanText.slice(0, 220)}…`
                                : selected.cleanText,
                            pincite: selected.pincite,
                          },
                          decision,
                        )}
                      </p>
                    )}
                  </PreviewPane>
                }
              >
                {COPY_MODES.map((mode) => (
                  <button
                    className="hover:bg-accent block w-full rounded-sm px-2 py-1.5 text-start text-xs whitespace-nowrap"
                    key={mode}
                    onClick={() => {
                      const text = copyTextFor(mode, selected, decision);
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
                        "case-law.selection-copy",
                      );
                      setCopyOpen(false);
                      clearSelection();
                    }}
                    onFocus={() => setCopyPreviewMode(mode)}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setCopyPreviewMode(mode)}
                    type="button"
                  >
                    {t(`caseLaw.copyMenu.${mode}`)}
                  </button>
                ))}
              </MenuPreviewLayout>
            </div>
          )}
        </div>
        <span className="bg-border mx-1 h-4 w-px" />
        <Button
          onClick={() => {
            askAboutSelection({
              caseNumber: decision.caseNumber,
              court: decision.court,
              decisionId: decision.id,
              quote: selected.text,
            });
            clearSelection();
          }}
          size="sm"
          variant="ghost"
        >
          <SparklesIcon className="size-3.5" />
          {t("common.askAI")}
        </Button>
        {spans.length > 0 && (
          <>
            <span className="bg-border mx-1 h-4 w-px" />
            {styleButtons(style, setStyle)}
            <div className="flex items-center gap-1.5 px-1">
              {colorSwatches((color) => createHighlight(spans, color))}
            </div>
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
      className="bg-popover text-popover-foreground fixed z-[100] -translate-x-1/2 rounded-md border p-1 font-sans text-xs shadow-md"
      ref={barRef}
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
    ? t("caseLaw.annotations.visibilityShared")
    : t("knowledge.agentSkills.scopePrivate");

  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          aria-pressed={shared}
          className="gap-1 px-1.5 text-[0.7rem]"
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
      return "caseLaw.annotations.colorYellow" as const;
    }
    case "green": {
      return "caseLaw.annotations.colorGreen" as const;
    }
    case "sky": {
      return "caseLaw.annotations.colorSky" as const;
    }
    case "violet": {
      return "caseLaw.annotations.colorViolet" as const;
    }
    case "red": {
      return "caseLaw.annotations.colorRed" as const;
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
      return "caseLaw.annotations.styleHighlight" as const;
    }
    case "underline": {
      return "folio.underline" as const;
    }
    case "squiggly": {
      return "caseLaw.annotations.styleSquiggly" as const;
    }
    case "strikethrough": {
      return "caseLaw.annotations.styleStrikethrough" as const;
    }
    default: {
      style satisfies never;
      return panic(`Unhandled style: ${String(style)}`);
    }
  }
};
