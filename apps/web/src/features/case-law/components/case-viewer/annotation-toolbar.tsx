import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

import {
  Building2Icon,
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

import { Button } from "@stll/ui/button";
import { Textarea } from "@stll/ui/textarea";
import { cn } from "@stll/ui/utils";

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
import type { DecisionAnnotation } from "@/features/case-law/queries/annotations";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";

/** Room above the words for the bar, so it never covers what was selected. */
const BAR_OFFSET_PX = 44;

export type AnnotationToolbarDecision = {
  caseNumber: string;
  court: string;
  id: string;
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
  scrollContainerRef: RefObject<HTMLElement | null>;
};

type Selected = {
  rect: DOMRect;
  /** One per paragraph the selection touches; empty outside the words. */
  spans: SelectionAnchor[];
  text: string;
};

type Composer = {
  rect: DOMRect;
  spans: SelectionAnchor[];
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
  onClearActive,
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
  const [composer, setComposer] = useState<Composer | null>(null);
  const [comment, setComment] = useState("");
  const [visibility, setVisibility] = useState<AnnotationVisibility>("private");

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
        setSelected({
          rect: selection.getRangeAt(0).getBoundingClientRect(),
          spans: selectionAnchorsFrom(selection, root),
          text,
        });
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setComposer(null);
        onClearActive();
        ownerDoc.getSelection()?.removeAllRanges();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (barRef.current?.contains(target) === true ||
          (target instanceof Element && target.closest("[data-annotation-id]")))
      ) {
        return;
      }
      setComposer(null);
      onClearActive();
    };
    ownerDoc.addEventListener("selectionchange", readSelection);
    ownerDoc.addEventListener("keydown", onKeyDown);
    ownerDoc.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      ownerDoc.removeEventListener("selectionchange", readSelection);
      ownerDoc.removeEventListener("keydown", onKeyDown);
      ownerDoc.removeEventListener("pointerdown", onPointerDown);
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

  const decisionUrl = (): string => {
    const view = doc?.defaultView;
    if (!view) {
      return "";
    }
    const url = new URL(view.location.href);
    url.hash = "";
    return url.href;
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

  const submitComment = () => {
    const body = comment.trim();
    if (composer === null || body === "") {
      return;
    }
    detached(
      controller.create({
        body,
        spans: composer.spans,
        kind: "comment",
        visibility,
      }),
      "case-law.annotation-comment",
    );
    setComment("");
    setComposer(null);
    clearSelection();
  };

  const rect = composer?.rect ?? activeRect ?? selected?.rect ?? null;
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
  if (composer !== null) {
    content = (
      <form
        className="flex w-72 flex-col gap-2 p-1"
        onSubmit={(event) => {
          event.preventDefault();
          submitComment();
        }}
      >
        <Textarea
          aria-label={t("caseLaw.annotations.comment")}
          autoFocus
          className="min-h-16 text-xs"
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitComment();
            }
          }}
          placeholder={t("caseLaw.annotations.commentPlaceholder")}
          value={comment}
        />
        <div className="flex items-center justify-between gap-2">
          <VisibilityToggle onChange={setVisibility} value={visibility} />
          <div className="flex items-center gap-1">
            <Button
              onClick={() => setComposer(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("common.cancel")}
            </Button>
            <Button disabled={comment.trim() === ""} size="sm" type="submit">
              {t("common.save")}
            </Button>
          </div>
        </div>
      </form>
    );
  } else if (activeAnnotation !== null) {
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
        {activeAnnotation.kind === "highlight" && activeRect !== null && (
          <>
            <Button
              onClick={() => {
                setComposer({
                  rect: activeRect,
                  spans: activeSpans.map((span) => ({
                    blockAnchorId: span.blockAnchorId,
                    endOffset: span.endOffset,
                    quote: span.quote,
                    startOffset: span.startOffset,
                  })),
                });
                onClearActive();
              }}
              size="sm"
              variant="ghost"
            >
              <MessageSquarePlusIcon className="size-3.5" />
              {t("caseLaw.annotations.comment")}
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
  } else if (selected !== null) {
    const spans = selected.spans;
    content = (
      <div className="flex items-center gap-1">
        <Button
          onClick={() => {
            askAboutSelection({
              caseNumber: decision.caseNumber,
              court: decision.court,
              decisionId: decision.id,
              decisionUrl: decisionUrl(),
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
              onClick={() => setComposer({ rect: selected.rect, spans })}
              size="sm"
              variant="ghost"
            >
              <MessageSquarePlusIcon className="size-3.5" />
              {t("caseLaw.annotations.comment")}
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
    : t("caseLaw.annotations.visibilityPrivate");

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
      const unreachable: never = color;
      return unreachable;
    }
  }
};

const styleLabelKey = (style: AnnotationStyle) => {
  switch (style) {
    case "highlight": {
      return "caseLaw.annotations.styleHighlight" as const;
    }
    case "underline": {
      return "caseLaw.annotations.styleUnderline" as const;
    }
    case "squiggly": {
      return "caseLaw.annotations.styleSquiggly" as const;
    }
    case "strikethrough": {
      return "caseLaw.annotations.styleStrikethrough" as const;
    }
    default: {
      const unreachable: never = style;
      return unreachable;
    }
  }
};
