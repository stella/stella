import type { ReactNode, RefObject } from "react";
import { useCallback, useRef, useState } from "react";

import type { LucideIcon } from "lucide-react";
import {
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  RepeatIcon,
  SplitIcon,
  TextQuoteIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import {
  getFolioSelectionViewportRect,
  getTemplateDirectives,
} from "@stll/folio-react";
import { Button } from "@stll/ui/components/button";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import {
  MenuPreviewLayout,
  PreviewPane,
} from "@stll/ui/components/preview-pane";
import { Separator } from "@stll/ui/components/separator";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { BoundedMap } from "@/lib/bounded-set";
import { inputTypeValueKind, VALUE_TYPE_META } from "@/lib/value-types";
import { reusableConditions } from "@/routes/_protected.knowledge/-components/template-studio-condition-source";
import { isInputType } from "@/routes/_protected.knowledge/-components/template-studio-model";
import {
  useTemplateStudioStore,
  type StudioField,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import type { TemplateEditableField } from "@/routes/_protected.knowledge/-components/template-wizard";

type SelectionGesturePopoverProps = {
  gesture: SelectionGesture;
  enrichment: GestureEnrichment;
  onMakeField: () => void;
  onInsertExisting: (path: string) => void;
  onAcceptAi: () => void;
  onWrapIf: () => void;
  onWrapIfExisting: (name: string) => void;
  onWrapEach: () => void;
  onMakeClause: () => void;
};

export const TemplateStudioSelectionGesture = ({
  gesture,
  enrichment,
  onMakeField,
  onInsertExisting,
  onAcceptAi,
  onWrapIf,
  onWrapIfExisting,
  onWrapEach,
  onMakeClause,
}: SelectionGesturePopoverProps) => {
  const t = useTranslations();
  const fields = useTemplateStudioStore((state) => state.fields);
  const [preview, setPreview] = useState<GestureInsertKind | null>(null);
  return (
    <div
      className="bg-popover text-popover-foreground absolute z-50 flex max-h-[min(26rem,80vh)] max-w-[min(92vw,30rem,100%)] flex-col overflow-y-auto rounded-lg border p-1 shadow-lg/5 transition-opacity duration-100 starting:opacity-0"
      role="group"
      style={{
        left: gesture.left,
        top: gesture.top,
        transform:
          gesture.placement === "above"
            ? `translate(-50%, calc(-100% - ${GESTURE_POPOVER_OFFSET_PX}px))`
            : `translate(-50%, ${GESTURE_POPOVER_OFFSET_PX}px)`,
      }}
    >
      <MenuPreviewLayout
        preview={
          <PreviewPane>
            {preview ? (
              <GestureInsertPreview key={preview} kind={preview} />
            ) : (
              <div className="text-muted-foreground flex h-full items-center justify-center text-center text-xs text-balance">
                {t("templates.studio.previewHint")}
              </div>
            )}
          </PreviewPane>
        }
      >
        <GestureSplitRow
          existing={fields.map((field) => ({
            key: field.path,
            icon: VALUE_TYPE_META[inputTypeValueKind(field.inputType)].icon,
            label: field.label === "" ? field.path : field.label,
            sublabel: field.label === "" ? undefined : field.path,
            onSelect: () => onInsertExisting(field.path),
          }))}
          icon={BracesIcon}
          label={t("templates.studio.makeField")}
          onDefault={onMakeField}
          onHighlight={() => setPreview("field")}
          reuseLabel={t("templates.studio.existingField")}
        />
        <GestureSplitRow
          existing={reusableConditions(fields, (key) => t(key)).map(
            (condition) => ({
              key: condition.ref,
              icon: SplitIcon,
              label: condition.label,
              onSelect: () => onWrapIfExisting(condition.ref),
            }),
          )}
          icon={SplitIcon}
          label={t("templates.studio.showOnlyIf")}
          onDefault={onWrapIf}
          onHighlight={() => setPreview("if")}
          reuseLabel={t("templates.studio.existingCondition")}
        />
        <Button
          className="justify-start gap-2 font-normal"
          onClick={onWrapEach}
          onFocus={() => setPreview("each")}
          onMouseDown={keepEditorFocus}
          onMouseEnter={() => setPreview("each")}
          size="sm"
          variant="ghost"
        >
          <RepeatIcon className="text-muted-foreground size-3.5 shrink-0" />
          {t("templates.studio.repeatForEach")}
        </Button>
        <Button
          className="justify-start gap-2 font-normal"
          onClick={onMakeClause}
          onFocus={() => setPreview("clause")}
          onMouseDown={keepEditorFocus}
          onMouseEnter={() => setPreview("clause")}
          size="sm"
          variant="ghost"
        >
          <TextQuoteIcon className="text-muted-foreground size-3.5 shrink-0" />
          {t("templates.studio.scopeClause")}
        </Button>
        {enrichment.status !== "idle" && (
          <>
            <Separator className="my-1" />
            <GestureAiRow
              enrichment={enrichment}
              fields={fields}
              onAcceptAi={onAcceptAi}
            />
          </>
        )}
      </MenuPreviewLayout>
    </div>
  );
};

/** Selecting prose settles before the popover shows, so drag and keyboard
 * selections do not flash the menu mid-gesture. */
const GESTURE_SHOW_DELAY_MS = 150;
/** The instant actions stay available while enrichment waits for a stable selection. */
const GESTURE_ENRICH_DELAY_MS = 500;
const GESTURE_POPOVER_OFFSET_PX = 8;
/** Half the popover's widest layout, used to clamp it inside the overlay host. */
const GESTURE_POPOVER_HALF_WIDTH_PX = 240;
/** Rough rendered height, used for the above/below placement decision. */
const GESTURE_POPOVER_EST_HEIGHT_PX = 280;
/** Bounds the known-field context sent to the suggestion endpoint. */
const GESTURE_ENRICH_MAX_PATHS = 30;
const GESTURE_ENRICH_PATHS_MAX_CHARS = 1000;
const GESTURE_ENRICHMENT_CACHE_MAX = 100;

/** The live text selection reported by Folio. */
type GestureSelection = { from: number; to: number; text: string };

/** A settled selection anchored relative to the parent-owned overlay host. */
type SelectionGesture = GestureSelection & {
  left: number;
  top: number;
  placement: "above" | "below";
};

/** Progressive AI proposal for the popover's optional enriched field row. */
type GestureEnrichment =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      label: string | undefined;
      inputType: TemplateEditableField["inputType"] | undefined;
      aiPrompt: string | undefined;
      fieldPath: string | undefined;
    };

/** Session-lived answers, bounded so repeated selections cannot grow memory forever. */
const gestureEnrichmentCache = new BoundedMap<string, GestureEnrichment>(
  GESTURE_ENRICHMENT_CACHE_MAX,
);

/** Tiny stable digest for the known-path portion of the enrichment cache key. */
const HASH_MODULUS = 2 ** 48;
const hashStrings = (values: readonly string[]): string => {
  let hash = 5381;
  for (const char of values.join("\u0000")) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % HASH_MODULUS;
  }
  return hash.toString(36);
};

/** Caps both the count and joined length of field paths sent for enrichment. */
const enrichmentKnownPaths = (fields: readonly StudioField[]): string[] => {
  const paths: string[] = [];
  let budget = GESTURE_ENRICH_PATHS_MAX_CHARS;
  for (const field of fields.slice(0, GESTURE_ENRICH_MAX_PATHS)) {
    budget -= field.path.length + 2;
    if (budget < 0) {
      break;
    }
    paths.push(field.path);
  }
  return paths;
};

const paragraphsAroundSelection = (
  state: EditorState,
  from: number,
): string => {
  const $from = state.doc.resolve(from);
  if ($from.depth === 0) {
    return $from.parent.textContent.slice(0, 4000);
  }
  const container = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  const texts: string[] = [];
  for (const i of [index - 1, index, index + 1]) {
    if (i < 0 || i >= container.childCount) {
      continue;
    }
    const text = container.child(i).textContent;
    if (text.trim() !== "") {
      texts.push(text);
    }
  }
  return texts.join("\n");
};

type SelectionRange = { from: number; to: number };

type UseTemplateStudioSelectionGestureOptions = {
  editorViewRef: RefObject<EditorView | null>;
  overlayHostRef: RefObject<HTMLDivElement | null>;
  makeField: (range: SelectionRange) => string | null;
  insertExistingField: (path: string, range: SelectionRange) => void;
  insertExistingCondition: (name: string, range: SelectionRange) => void;
  insertClause: (range: SelectionRange) => void;
  wrapBlock: (kind: "if" | "each", range: SelectionRange) => void;
  upsertField: (path: string, patch: Partial<StudioField>) => void;
};

/** Owns the selection gesture lifecycle while document mutations stay explicit inputs. */
export const useTemplateStudioSelectionGesture = ({
  editorViewRef,
  overlayHostRef,
  makeField,
  insertExistingField,
  insertExistingCondition,
  insertClause,
  wrapBlock,
  upsertField,
}: UseTemplateStudioSelectionGestureOptions) => {
  const t = useTranslations();
  const [gesture, setGestureState] = useState<SelectionGesture | null>(null);
  const gestureRef = useRef<SelectionGesture | null>(null);
  const setGesture = (next: SelectionGesture | null) => {
    gestureRef.current = next;
    setGestureState(next);
  };
  const [enrichment, setEnrichment] = useState<GestureEnrichment>({
    status: "idle",
  });
  const enrichSeqRef = useRef(0);

  const hideGesture = useCallback(() => {
    enrichSeqRef.current += 1;
    gestureRef.current = null;
    setGestureState(null);
    setEnrichment({ status: "idle" });
  }, []);

  const showGesture = useDebouncedCallback((selection: GestureSelection) => {
    const view = editorViewRef.current;
    const host = overlayHostRef.current;
    if (!view || !host) {
      return;
    }
    const { from, to } = view.state.selection;
    if (from === to || from !== selection.from || to !== selection.to) {
      return;
    }
    const scrollContainer = view.dom.closest("[data-folio-scroll]");
    if (!scrollContainer || !scrollContainer.contains(document.activeElement)) {
      return;
    }
    const overlapsDirective = getTemplateDirectives(view.state).some(
      (range) => range.from < to && range.to > from,
    );
    if (overlapsDirective) {
      return;
    }
    let attempts = 0;
    const read = () => {
      const liveView = editorViewRef.current;
      if (!liveView) {
        return;
      }
      const live = liveView.state.selection;
      if (live.from !== selection.from || live.to !== selection.to) {
        return;
      }
      const rect = getFolioSelectionViewportRect(liveView);
      if (!rect) {
        attempts += 1;
        if (attempts < 10) {
          requestAnimationFrame(read);
        }
        return;
      }
      const hostRect = host.getBoundingClientRect();
      const fitsBelow =
        rect.bottom -
          hostRect.top +
          GESTURE_POPOVER_OFFSET_PX +
          GESTURE_POPOVER_EST_HEIGHT_PX <
        host.clientHeight;
      const placement = fitsBelow ? "below" : "above";
      const center = rect.left + rect.width / 2 - hostRect.left;
      const halfWidth = Math.min(
        GESTURE_POPOVER_HALF_WIDTH_PX,
        host.clientWidth / 2,
      );
      setGesture({
        ...selection,
        left: Math.min(
          Math.max(center, halfWidth),
          Math.max(halfWidth, host.clientWidth - halfWidth),
        ),
        top:
          placement === "below"
            ? rect.bottom - hostRect.top
            : rect.top - hostRect.top,
        placement,
      });
    };
    requestAnimationFrame(read);
  }, GESTURE_SHOW_DELAY_MS);

  const fetchGestureSuggestion = async (
    selection: GestureSelection,
    sequence: number,
  ) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const contextText = paragraphsAroundSelection(view.state, selection.from);
    const knownPaths = enrichmentKnownPaths(
      useTemplateStudioStore.getState().fields,
    );
    const cacheKey = `${selection.text}\u0000${contextText}\u0000${hashStrings(knownPaths)}`;
    const cached = gestureEnrichmentCache.get(cacheKey);
    if (cached !== undefined) {
      setEnrichment(cached);
      return;
    }
    setEnrichment({ status: "loading" });
    const existingFieldsClause =
      knownPaths.length === 0
        ? ""
        : ` The template already has these fields: ${knownPaths.join(", ")}.` +
          ` If the selection is just another occurrence of one of them, set` +
          ` fieldPath to that exact existing path instead of inventing a` +
          ` new field.`;
    const response = await api.templates["suggest-fields"].post({
      text: contextText,
      instructions:
        `The user selected this exact text: "${selection.text}". Propose exactly ` +
        `ONE field for that exact selection (literalText must equal it): ` +
        `its label and input type, plus an aiPrompt only when the selection ` +
        `is free-form prose that AI should draft at fill ` +
        `time.${existingFieldsClause}`,
    });
    if (sequence !== enrichSeqRef.current) {
      return;
    }
    if (response.error) {
      getAnalytics().captureError(response.error);
      setEnrichment({ status: "idle" });
      return;
    }
    const match = response.data.suggestions.at(0);
    if (!match) {
      setEnrichment({ status: "idle" });
      return;
    }
    const ready: GestureEnrichment = {
      status: "ready",
      label: match.label,
      inputType:
        match.inputType !== undefined && isInputType(match.inputType)
          ? match.inputType
          : undefined,
      aiPrompt: match.aiPrompt,
      fieldPath: match.fieldPath,
    };
    gestureEnrichmentCache.set(cacheKey, ready);
    setEnrichment(ready);
  };

  const enrichGesture = useDebouncedCallback((selection: GestureSelection) => {
    const shown = gestureRef.current;
    if (
      shown === null ||
      shown.from !== selection.from ||
      shown.to !== selection.to
    ) {
      return;
    }
    const sequence = ++enrichSeqRef.current;
    fetchGestureSuggestion(selection, sequence).catch((error: unknown) => {
      if (sequence !== enrichSeqRef.current) {
        return;
      }
      getAnalytics().captureError(error);
      setEnrichment({ status: "idle" });
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    });
  }, GESTURE_ENRICH_DELAY_MS);

  const onSelectionTextChange = (selection: GestureSelection) => {
    if (selection.text.trim() === "") {
      showGesture.cancel();
      enrichGesture.cancel();
      hideGesture();
      return;
    }
    const shown = gestureRef.current;
    if (
      shown !== null &&
      (shown.from !== selection.from || shown.to !== selection.to)
    ) {
      hideGesture();
    }
    showGesture(selection);
    enrichGesture(selection);
  };

  const dismissGesture = () => {
    showGesture.cancel();
    enrichGesture.cancel();
    hideGesture();
  };

  const applyExistingFieldGesture = (path: string) => {
    const shown = gestureRef.current;
    if (shown === null) {
      return;
    }
    insertExistingField(path, { from: shown.from, to: shown.to });
    dismissGesture();
  };

  const applyExistingConditionGesture = (conditionName: string) => {
    const shown = gestureRef.current;
    if (shown === null) {
      return;
    }
    insertExistingCondition(conditionName, {
      from: shown.from,
      to: shown.to,
    });
    dismissGesture();
  };

  const applyAiGesture = () => {
    const shown = gestureRef.current;
    if (shown === null || enrichment.status !== "ready") {
      return;
    }
    const range = { from: shown.from, to: shown.to };
    const existing =
      enrichment.fieldPath === undefined
        ? undefined
        : useTemplateStudioStore
            .getState()
            .fields.find((field) => field.path === enrichment.fieldPath);
    if (existing !== undefined) {
      insertExistingField(existing.path, range);
    } else {
      const path = makeField(range);
      if (path !== null) {
        upsertField(path, {
          ...(enrichment.label !== undefined && enrichment.label !== ""
            ? { label: enrichment.label }
            : {}),
          ...(enrichment.inputType !== undefined
            ? { inputType: enrichment.inputType }
            : {}),
          ...(enrichment.aiPrompt !== undefined
            ? { aiPrompt: enrichment.aiPrompt }
            : {}),
        });
      }
    }
    dismissGesture();
  };

  const applyGesture = (kind: "field" | "if" | "each" | "clause") => {
    const shown = gestureRef.current;
    if (shown === null) {
      return;
    }
    const range = { from: shown.from, to: shown.to };
    if (kind === "field") {
      makeField(range);
    } else if (kind === "clause") {
      insertClause(range);
    } else {
      wrapBlock(kind, range);
    }
    dismissGesture();
  };

  const gestureShown = gesture !== null;
  useExternalSyncEffect(() => {
    if (!gestureShown) {
      return undefined;
    }
    const host = overlayHostRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hideGesture();
      }
    };
    const dismiss = () => hideGesture();
    window.addEventListener("keydown", onKeyDown);
    host?.addEventListener("scroll", dismiss, {
      capture: true,
      passive: true,
    });
    host?.addEventListener("contextmenu", dismiss, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      host?.removeEventListener("scroll", dismiss, { capture: true });
      host?.removeEventListener("contextmenu", dismiss, { capture: true });
    };
  }, [gestureShown, hideGesture, overlayHostRef]);

  useExternalSyncEffect(
    () => () => {
      showGesture.cancel();
      enrichGesture.cancel();
    },
    [showGesture, enrichGesture],
  );

  return {
    onSelectionTextChange,
    renderState:
      gesture === null
        ? null
        : {
            gesture,
            enrichment,
            onAcceptAi: applyAiGesture,
            onInsertExisting: applyExistingFieldGesture,
            onMakeClause: () => applyGesture("clause"),
            onMakeField: () => applyGesture("field"),
            onWrapEach: () => applyGesture("each"),
            onWrapIf: () => applyGesture("if"),
            onWrapIfExisting: applyExistingConditionGesture,
          },
  };
};

type GestureInsertKind = "field" | "if" | "each" | "clause";

// Mock document content, not interface text; deliberately untranslated (see
// the preview-pane pattern) so the previews carry no per-language i18n debt.
// The concept caption below each IS translated (templates.studio.concept*).
const GESTURE_PREVIEW_SAMPLE = {
  fieldBefore: "Due within ",
  fieldMarker: "{{term}}",
  fieldValue: "30",
  fieldAfter: " days.",
  ifMarker: "{{#if has_guarantor}}",
  ifBody: "The Guarantor shall be jointly liable.",
  eachMarker: "{{#each parties}}",
  eachItem: "– {{name}}, {{role}}",
  eachFilled: ["– Jane Roe, Buyer", "– John Doe, Seller"],
  clauseMarker: "{{@clause:liability}}",
  clauseText: "Neither party is liable for indirect or consequential loss.",
} as const;

const CONCEPT_KEY = {
  field: "templates.studio.conceptField",
  if: "templates.studio.conceptCondition",
  each: "templates.studio.conceptLoop",
  clause: "templates.studio.conceptClause",
} as const satisfies Record<GestureInsertKind, TranslationKey>;

/** One-shot reveal: fills in after a short beat and stays (no loop). */
const useFillReveal = (): boolean => {
  const [filled, setFilled] = useState(false);
  useMountEffect(() => {
    const id = setTimeout(() => setFilled(true), 600);
    return () => clearTimeout(id);
  });
  return filled;
};

/** Cross-fades the whole template form into the whole filled result, stacked in
 *  one grid cell sized to both — so the surrounding layout never reflows and a
 *  shorter filled line just leaves harmless trailing space (no mid-text gap).
 *  Opacity only (GPU-friendly); one-shot, settles on the filled layer. */
const FillReveal = ({
  on,
  marker,
  filled,
  className,
}: {
  on: boolean;
  marker: ReactNode;
  filled: ReactNode;
  className?: string;
}) => (
  <span className={cn("grid [&>*]:col-start-1 [&>*]:row-start-1", className)}>
    <span
      aria-hidden={on}
      className="transition-opacity duration-500"
      style={{ opacity: on ? 0 : 1 }}
    >
      {marker}
    </span>
    <span
      aria-hidden={!on}
      className="transition-opacity duration-500"
      style={{ opacity: on ? 1 : 0 }}
    >
      {filled}
    </span>
  </span>
);

/** Popover buttons act on the captured selection; preventing mousedown keeps
 * focus (and the painted selection) in the editor while clicking. */
const keepEditorFocus = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

const GestureInsertPreview = ({ kind }: { kind: GestureInsertKind }) => {
  const t = useTranslations();
  const filled = useFillReveal();

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col justify-center overflow-hidden text-sm leading-relaxed">
        {kind === "field" && (
          <FillReveal
            className="whitespace-nowrap"
            filled={
              <span>
                {GESTURE_PREVIEW_SAMPLE.fieldBefore}
                <span className="text-foreground font-semibold">
                  {GESTURE_PREVIEW_SAMPLE.fieldValue}
                </span>
                {GESTURE_PREVIEW_SAMPLE.fieldAfter}
              </span>
            }
            marker={
              <span>
                {GESTURE_PREVIEW_SAMPLE.fieldBefore}
                <code className="bg-primary/10 text-primary rounded px-1 py-0.5 text-xs">
                  {GESTURE_PREVIEW_SAMPLE.fieldMarker}
                </code>
                {GESTURE_PREVIEW_SAMPLE.fieldAfter}
              </span>
            }
            on={filled}
          />
        )}

        {kind === "if" && (
          <div className="border-foreground-disabled bg-accent/50 rounded-sm border-s-[3px] py-1.5 ps-3 pe-2">
            <FillReveal
              className="block"
              filled={
                <span className="text-success inline-flex items-center gap-1 text-xs">
                  <CheckIcon className="size-3" />
                </span>
              }
              marker={
                <code className="text-muted-foreground block text-xs">
                  {GESTURE_PREVIEW_SAMPLE.ifMarker}
                </code>
              }
              on={filled}
            />
            <span className="mt-1 block">{GESTURE_PREVIEW_SAMPLE.ifBody}</span>
          </div>
        )}

        {kind === "each" && (
          <div className="border-success/40 bg-success/10 rounded-sm border-s-[3px] py-1.5 ps-3 pe-2">
            <FillReveal
              className="block"
              filled={
                <span className="block">
                  {GESTURE_PREVIEW_SAMPLE.eachFilled.map((row) => (
                    <span className="block" key={row}>
                      {row}
                    </span>
                  ))}
                </span>
              }
              marker={
                <span className="block">
                  <code className="text-muted-foreground text-xs">
                    {GESTURE_PREVIEW_SAMPLE.eachMarker}
                  </code>
                  <span className="mt-1 block">
                    {GESTURE_PREVIEW_SAMPLE.eachItem}
                  </span>
                </span>
              }
              on={filled}
            />
          </div>
        )}

        {kind === "clause" && (
          <FillReveal
            className="block"
            filled={
              <span className="block leading-relaxed">
                {GESTURE_PREVIEW_SAMPLE.clauseText}
              </span>
            }
            marker={
              <span className="bg-card flex items-center gap-1.5 rounded-sm border border-dashed p-2">
                <TextQuoteIcon className="text-muted-foreground size-3.5 shrink-0" />
                <code className="text-muted-foreground text-xs">
                  {GESTURE_PREVIEW_SAMPLE.clauseMarker}
                </code>
              </span>
            }
            on={filled}
          />
        )}
      </div>
      <p className="text-muted-foreground mt-1.5 shrink-0 text-[11px] leading-snug">
        {t(CONCEPT_KEY[kind])}
      </p>
    </div>
  );
};

/** One reusable item in a {@link GestureSplitRow}'s expand list. */
type GestureExistingOption = {
  key: string;
  icon: LucideIcon;
  label: string;
  /** Secondary muted text (e.g. a field's path), shown right-aligned. */
  sublabel?: string | undefined;
  onSelect: () => void;
};

/** A gesture-menu row whose primary click creates something new (the sensible
 *  default); a trailing chevron expands an inline list of existing items to
 *  reuse instead, so reuse is exactly one extra click. Used for both fields
 *  ("Make field" + existing fields) and conditions ("Show only if" + existing
 *  conditions), keeping the two symmetric. */
const GestureSplitRow = ({
  icon: Icon,
  label,
  reuseLabel,
  onDefault,
  onHighlight,
  existing,
}: {
  icon: LucideIcon;
  label: string;
  reuseLabel: string;
  onDefault: () => void;
  /** Drive the preview pane while the default (create-new) button is hovered
   *  or focused. */
  onHighlight: () => void;
  existing: GestureExistingOption[];
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center gap-0.5">
        <Button
          className="flex-1 justify-start gap-2 font-normal"
          onClick={onDefault}
          onFocus={onHighlight}
          onMouseDown={keepEditorFocus}
          onMouseEnter={onHighlight}
          size="sm"
          variant="ghost"
        >
          <Icon className="text-muted-foreground size-3.5 shrink-0" />
          {label}
        </Button>
        {existing.length > 0 && (
          <Button
            aria-expanded={open}
            aria-label={reuseLabel}
            className="shrink-0"
            onClick={() => setOpen((isOpen) => !isOpen)}
            onMouseDown={keepEditorFocus}
            size="icon-sm"
            title={reuseLabel}
            variant="ghost"
          >
            {open ? (
              <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
            ) : (
              <DirectionalIcon
                className="text-muted-foreground size-3.5 shrink-0"
                icon={ChevronRightIcon}
              />
            )}
          </Button>
        )}
      </div>
      {open && (
        <div className="flex max-h-44 flex-col overflow-y-auto">
          {existing.map((option) => {
            const OptionIcon = option.icon;
            return (
              <Button
                className="justify-start gap-2 ps-7 font-normal"
                key={option.key}
                onClick={option.onSelect}
                onMouseDown={keepEditorFocus}
                size="sm"
                title={option.sublabel ?? option.label}
                variant="ghost"
              >
                <OptionIcon className="text-muted-foreground size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{option.label}</span>
                {option.sublabel === undefined ? null : (
                  <code className="text-muted-foreground ms-auto min-w-0 truncate text-[10px]">
                    {option.sublabel}
                  </code>
                )}
              </Button>
            );
          })}
        </div>
      )}
    </>
  );
};

/** The AI slot under the separator: a shimmer while the proposal is in
 *  flight, then the proposal as a quietly accented row — proposed type icon
 *  left, wand right. A proposal that points at an existing field reads as
 *  "Use existing …" and reuses it instead of creating a duplicate. */
const GestureAiRow = ({
  enrichment,
  fields,
  onAcceptAi,
}: {
  enrichment: GestureEnrichment;
  fields: StudioField[];
  onAcceptAi: () => void;
}) => {
  const t = useTranslations();
  if (enrichment.status !== "ready") {
    return (
      <div className="flex h-8 items-center px-2.5">
        <span
          aria-hidden="true"
          className="bg-muted h-1.5 w-16 animate-pulse rounded-full"
        />
      </div>
    );
  }
  const existing =
    enrichment.fieldPath === undefined
      ? undefined
      : fields.find((f) => f.path === enrichment.fieldPath);
  let label: string;
  let TypeIcon: LucideIcon;
  if (existing !== undefined) {
    label = t("templates.studio.useExisting", {
      name: existing.label === "" ? existing.path : existing.label,
    });
    TypeIcon = VALUE_TYPE_META[inputTypeValueKind(existing.inputType)].icon;
  } else {
    label =
      enrichment.label !== undefined && enrichment.label !== ""
        ? enrichment.label
        : t("templates.studio.makeField");
    TypeIcon =
      VALUE_TYPE_META[inputTypeValueKind(enrichment.inputType ?? "text")].icon;
  }
  return (
    <Button
      className="bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary justify-start gap-2 font-normal"
      onClick={onAcceptAi}
      onMouseDown={keepEditorFocus}
      size="sm"
      title={label}
      variant="ghost"
    >
      <TypeIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      <WandSparklesIcon className="ms-auto size-3.5 shrink-0" />
    </Button>
  );
};
