import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { panic } from "better-result";
import {
  BookmarkIcon,
  BookmarkPlusIcon,
  BracesIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LandmarkIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RepeatIcon,
  SaveIcon,
  SigmaIcon,
  SplitIcon,
  Trash2Icon,
  UserIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { Node as PMNode, NodeType, ResolvedPos } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import type { TemplateRecipeDefinition } from "@stll/api/types";
import {
  buildPositionalText,
  getFolioSelectionViewportRect,
  getTemplateDirectives,
  setTemplatePreviewValues,
} from "@stll/folio";
import type { DirectiveRange, DocxEditorRef } from "@stll/folio";
import { isFieldPath } from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Separator } from "@stll/ui/components/separator";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import "@stll/folio/editor.css";

import { FacetBar } from "@/components/inspector/inspector-facet-bar";
import { useInspectorStore } from "@/components/inspector/inspector-store";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import { registerInspectorView } from "@/components/inspector/view-registry";
import { api } from "@/lib/api";
import {
  DOCX_MIME,
  SIDE_RAIL_TAB_ICON_SIZE_PX,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { inputTypeValueKind, VALUE_TYPE_META } from "@/lib/value-types";
import { LinkClauseDialog } from "@/routes/_protected.knowledge/-components/link-clause-dialog";
import { TemplateClausesTab } from "@/routes/_protected.knowledge/-components/template-clauses-tab";
import { DATE_FORMAT_STYLES } from "@/routes/_protected.knowledge/-components/template-date-format";
import { TemplateForm } from "@/routes/_protected.knowledge/-components/template-form";
import { useTemplateNavStore } from "@/routes/_protected.knowledge/-components/template-nav-store";
import { TemplateStudioChat } from "@/routes/_protected.knowledge/-components/template-studio-chat";
import {
  defaultStudioField,
  type NameExpr,
  type OutlineNode,
  type StudioActions,
  type StudioField,
  useTemplateStudioStore,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import { filledByForFieldMeta } from "@/routes/_protected.knowledge/-components/template-studio-suggestions";
import { TemplateVersionsTab } from "@/routes/_protected.knowledge/-components/template-versions-tab";
import {
  type EditablePart,
  type EditableField,
  FieldConfigEditor,
} from "@/routes/_protected.knowledge/-components/template-wizard";
import {
  knowledgeKeys,
  templateClausesOptions,
  templateDetailOptions,
  templateDocxBufferOptions,
  templateRecipesOptions,
} from "@/routes/_protected.knowledge/-queries";

const DocxEditor = lazy(async () => {
  const m = await import("@stll/folio");
  return { default: m.DocxEditor };
});

const protectedRouteApi = getRouteApi("/_protected");

const TEMPLATE_STUDIO_VIEW = "template-studio";
const MAKE_FIELD_CONTEXT_ID = "make-field";
const WRAP_IF_CONTEXT_ID = "wrap-if";
const WRAP_EACH_CONTEXT_ID = "wrap-each";
const TEMPLATES_ROUTE_ID = "/_protected/knowledge/templates";
const templateStudioTabId = (templateId: string) =>
  `template-studio:${templateId}`;

type TemplateStudioPayload = { templateId: string };

// ── Selection gesture popover ────────────────────────────

/** Selecting prose settles for this long before the popover shows; drag and
 *  shift+arrow selections re-arm it instead of flashing mid-gesture. */
const GESTURE_SHOW_DELAY_MS = 150;
/** Pause on a stable selection before asking the model to enrich the
 *  Make-field row. The instant buttons never wait for this. */
const GESTURE_ENRICH_DELAY_MS = 500;
const GESTURE_POPOVER_OFFSET_PX = 8;
/** Half the popover's fixed width (w-56), for clamping inside the host. */
const GESTURE_POPOVER_HALF_WIDTH_PX = 116;
/** Rough rendered height of the three-row popover, for the flip decision. */
const GESTURE_POPOVER_EST_HEIGHT_PX = 120;
/** Source-phrase cap for the bilingual-mirror instruction (the suggest
 *  endpoint bounds `instructions` at 2000 chars). */
const MIRROR_SOURCE_MAX_CHARS = 400;
/** Mirror-offer toasts stay long enough to rename the placeholder first. */
const MIRROR_OFFER_TOAST_MS = 10_000;

/** The live text selection in the document, as reported by Folio. */
type GestureSelection = { from: number; to: number; text: string };

/** A settled selection the gesture popover is anchored to; `left`/`top` are
 *  relative to the page's document wrapper (the popover's offset parent). */
type SelectionGesture = GestureSelection & {
  left: number;
  top: number;
  placement: "above" | "below";
};

/** Progressive AI enrichment of the popover's Make-field row. */
/** Session-lived answers for the selection popover, keyed by exact selection
 *  + surrounding context; bounded FIFO so it cannot grow unchecked. */
const gestureEnrichmentCache = new Map<string, GestureEnrichment>();
const GESTURE_ENRICHMENT_CACHE_MAX = 100;

type GestureEnrichment =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      label: string | undefined;
      inputType: EditableField["inputType"] | undefined;
      aiPrompt: string | undefined;
    };

/**
 * Template Studio page: the document (Folio) fills the surface, with a slim
 * action bar above it. The whole-template / per-field settings live in a single
 * tab in the global right-side Inspector (registered below), so the document
 * gets the full width. The page seeds a module-level session store the inspector
 * tab reads from, and opens/closes that tab over its own lifetime. Field
 * metadata lives in the manifest; on save the edited manifest is re-embedded
 * (/document) and the bytes stored as a new version.
 */
export const TemplateStudioPage = ({
  templateId,
  presignedUrl,
  fileName,
  manifest,
  name,
  metaLabel,
}: {
  templateId: string;
  presignedUrl: string;
  fileName: string;
  manifest: unknown;
  /** Template name, used as the inspector tab label (rename lives there too). */
  name: string;
  /** Field-count + date summary line. */
  metaLabel: string;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const editorRef = useRef<DocxEditorRef>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const { containerRef, fitZoom } = useFitToWidth();

  const init = useTemplateStudioStore((s) => s.init);
  const reset = useTemplateStudioStore((s) => s.reset);
  const setSelected = useTemplateStudioStore((s) => s.setSelected);
  const upsertField = useTemplateStudioStore((s) => s.upsertField);
  const markDirty = useTemplateStudioStore((s) => s.markDirty);
  const markSaved = useTemplateStudioStore((s) => s.markSaved);
  const openView = useInspectorStore((s) => s.openView);
  const closeTab = useInspectorStore((s) => s.closeTab);

  const [hasSelection, setHasSelection] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showDirectives, setShowDirectives] = useState(true);
  // Latest fill-preview values; re-dispatched when the eye toggles modes
  // (eye on = orange preview accents, eye off = plain final-looking text).
  const fillPreviewRef = useRef<Record<string, string> | null>(null);
  // Reactive twin of editorViewRef for children that re-render on view
  // creation (the floating AI bar needs a live prop, not a ref).
  const [liveEditorView, setLiveEditorView] = useState<EditorView | null>(null);
  // Right-click on selected text offers the structural gestures directly:
  // turn it into a {{field}}, or wrap it in a condition / loop block.
  const makeFieldContextItems = useMemo(
    () => [
      {
        id: MAKE_FIELD_CONTEXT_ID,
        label: t("templates.studio.makeField"),
        requiresSelection: true,
        icon: <BracesIcon size={14} />,
      },
      {
        id: WRAP_IF_CONTEXT_ID,
        label: t("templates.studio.showOnlyIf"),
        requiresSelection: true,
        icon: <SplitIcon size={14} />,
      },
      {
        id: WRAP_EACH_CONTEXT_ID,
        label: t("templates.studio.repeatForEach"),
        requiresSelection: true,
        icon: <RepeatIcon size={14} />,
      },
    ],
    [t],
  );

  const getEditorView = useCallback(() => editorViewRef.current, []);
  const forceEditorView = useCallback(() => {
    editorRef.current?.ensureEditorView({ focus: false });
  }, []);

  // The document actions render in the Studio's inspector tab (its top row),
  // not in a page toolbar — register them + the UI state they reflect. The ref
  // indirection keeps the registered closures stable while handlers re-create
  // per render.
  const actionsRef = useRef<StudioActions | null>(null);
  const setActions = useTemplateStudioStore((s) => s.setActions);
  const patchUi = useTemplateStudioStore((s) => s.patchUi);
  useEffect(() => {
    setActions({
      toggleDirectives: () => actionsRef.current?.toggleDirectives(),
      insertField: () => actionsRef.current?.insertField(),
      insertCondition: () => actionsRef.current?.insertCondition(),
      insertLoop: () => actionsRef.current?.insertLoop(),
      insertClause: () => actionsRef.current?.insertClause(),
      insertClauseSlot: (slotName) =>
        actionsRef.current?.insertClauseSlot(slotName),
      makeField: () => actionsRef.current?.makeField(),
      save: () => actionsRef.current?.save(),
      suggestFieldConfig: async (path) =>
        (await actionsRef.current?.suggestFieldConfig(path)) ?? null,
      renameFieldPath: (oldPath, newPath) =>
        actionsRef.current?.renameFieldPath(oldPath, newPath) ?? false,
      rewriteConditionExpr: (next) =>
        actionsRef.current?.rewriteConditionExpr(next) ?? false,
      deselect: () => actionsRef.current?.deselect(),
      focusAdjacentField: (direction) =>
        actionsRef.current?.focusAdjacentField(direction),
      focusField: (path) => actionsRef.current?.focusField(path),
      focusPosition: (pos) => actionsRef.current?.focusPosition(pos),
      setFillPreview: (values) => actionsRef.current?.setFillPreview(values),
      insertExistingField: (path) =>
        actionsRef.current?.insertExistingField(path),
      insertRecipe: (definition) =>
        actionsRef.current?.insertRecipe(definition),
    });
    return () => setActions(null);
  }, [setActions]);
  useEffect(() => {
    patchUi({ metaLabel });
  }, [patchUi, metaLabel]);
  useEffect(() => {
    patchUi({ showDirectives });
  }, [patchUi, showDirectives]);
  useEffect(() => {
    patchUi({ hasSelection });
  }, [patchUi, hasSelection]);
  useEffect(() => {
    patchUi({ isSaving });
  }, [patchUi, isSaving]);

  const {
    data: loadedBuffer,
    isLoading,
    isError,
  } = useQuery(
    templateDocxBufferOptions(activeOrganizationId, templateId, presignedUrl),
  );
  const [docBuffer, setDocBuffer] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    if (loadedBuffer && docBuffer === null) {
      setDocBuffer(loadedBuffer);
    }
  }, [loadedBuffer, docBuffer]);

  // Seed the shared session from the manifest and open the Fields/Clauses/
  // History tab in the global inspector; tear both down when the page unmounts
  // (leaving the studio). Keyed on templateId so editing the manifest in the
  // tab doesn't re-seed and discard in-progress edits.
  useEffect(() => {
    init({
      templateId,
      fields: parseFields(manifest),
      conditions: parseConditions(manifest),
    });
    openView({
      type: TEMPLATE_STUDIO_VIEW,
      id: templateStudioTabId(templateId),
      label: name,
      payload: { templateId },
      ownerRouteId: TEMPLATES_ROUTE_ID,
    });
    return () => {
      closeTab(templateStudioTabId(templateId));
      reset(templateId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per template; the manifest is the fixed source doc for this templateId and re-seeding would discard edits made in the inspector tab.
  }, [templateId]);

  // The eye toggles the preview between accented and plain rendering.
  useEffect(() => {
    const view = editorViewRef.current;
    const values = fillPreviewRef.current;
    if (!view || values === null) {
      return;
    }
    setTemplatePreviewValues(view, {
      values,
      mode: showDirectives ? "highlighted" : "plain",
    });
  }, [showDirectives]);

  // Warn before a tab close / hard navigation while there are unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (useTemplateStudioStore.getState().isDirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Folio defers creating the ProseMirror view until first interaction, so
  // onEditorViewReady never fires and the selection->inspector binding can't
  // read directives. Force the view once the document is loaded (the editor
  // mounts lazily, so poll the ref until it's available).
  useEffect(() => {
    if (!docBuffer) {
      return undefined;
    }
    let raf = 0;
    const ensure = () => {
      if (editorRef.current) {
        editorRef.current.ensureEditorView({ focus: false });
      } else {
        raf = requestAnimationFrame(ensure);
      }
    };
    ensure();
    return () => cancelAnimationFrame(raf);
  }, [docBuffer]);

  const setOutline = useTemplateStudioStore((s) => s.setOutline);

  // Map the editor's caret to the directive it sits in, so the inspector tab
  // knows which face to show. Reads the live plugin state via the captured
  // view; the outline rebuild rides along (same scan, fires on every edit).
  const syncSelection = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) {
      setSelected(null);
      return;
    }
    const directives = getTemplateDirectives(view.state);
    const head = view.state.selection.from;
    const covering = directives.find(
      (range) => head >= range.from && head <= range.to,
    );
    // Clicking plain text keeps the current face open — mid-configuration
    // clicks into the document (selecting text to copy into a field's
    // settings) must not hide the work in progress. Only landing in another
    // marker switches; the face's back chevron leaves deliberately.
    if (covering !== undefined) {
      setSelected(covering);
    } else {
      // Refresh a stale range for the still-shown directive (its position
      // may have shifted with edits) without dropping the face.
      const current = useTemplateStudioStore.getState().selected;
      if (current !== null) {
        const samePath = directives.find(
          (range) => range.kind === current.kind && range.expr === current.expr,
        );
        setSelected(samePath ?? null);
      }
    }
    setOutline(buildOutline(directives));
  }, [setSelected, setOutline]);

  // ── Bilingual mirroring ──────────────────────────────────
  // A structural gesture inside a table cell with exactly one text-bearing
  // sibling cell (two-column bilingual documents) offers repeating the
  // gesture on the parallel cell. Never silent: a field mirror lands as an
  // accept/reject in-document suggestion, a block mirror as a toast action.

  /** Bilingual mirror for Make field: ask the model for the EXACT verbatim
   *  substring of the parallel cell that corresponds to the source phrase,
   *  then queue an accept/reject in-document suggestion replacing it with
   *  the same `{{path}}` marker. No confident verbatim hit, no proposal. */
  const proposeFieldMirror = async ({
    path,
    sourceText,
    sibling,
  }: {
    path: string;
    sourceText: string;
    sibling: SiblingCell;
  }) => {
    const phrase = sourceText.slice(0, MIRROR_SOURCE_MAX_CHARS);
    const response = await api.templates["suggest-fields"].post({
      text: sibling.text,
      instructions:
        `This text is the parallel-language twin of a clause in which the ` +
        `exact phrase "${phrase}" became the field {{${path}}}. Return ` +
        `exactly ONE suggestion: fieldPath must be "${path}" and ` +
        `literalText must be the EXACT verbatim substring of this text ` +
        `that corresponds to that phrase. If there is no clear ` +
        `correspondence, return no suggestions.`,
    });
    if (response.error) {
      return;
    }
    const literal = response.data.suggestions.at(0)?.literalText ?? "";
    // Anchor only on a verbatim hit inside the sibling cell that is not
    // itself marker text; anything else means no confident match.
    if (
      literal === "" ||
      literal.includes("{{") ||
      literal.includes("}}") ||
      !sibling.text.includes(literal)
    ) {
      return;
    }
    const { fields, enqueueMirrorRequests } = useTemplateStudioStore.getState();
    const field =
      fields.find((f) => f.path === path) ?? defaultStudioField(path);
    enqueueMirrorRequests([
      {
        spec: {
          id: `mirror-field-${path}`,
          literalText: literal,
          suggestedText: `{{${path}}}`,
          topic: path,
          rationale: t("templates.studio.mirrorFieldRationale"),
          scopeText: sibling.text,
          display: {
            valueKind: inputTypeValueKind(field.inputType),
            filledBy: filledByForFieldMeta({ path, aiPrompt: field.aiPrompt }),
          },
        },
        onAccepted: () => {
          // One field now fills two languages, so AI adapts the wording
          // per occurrence — unless the value is structural (lookup /
          // formula / composite) or not prose (no letters: IDs, amounts).
          const current = useTemplateStudioStore
            .getState()
            .fields.find((f) => f.path === path);
          if (current === undefined || current.aiAdapt) {
            return;
          }
          const structural =
            current.lookup !== undefined ||
            current.formula !== undefined ||
            current.parts !== undefined;
          if (structural || !/\p{L}/u.test(sourceText)) {
            return;
          }
          upsertField(path, { aiAdapt: true });
        },
      },
    ]);
  };

  // The hero gesture: turn the current text selection into a `{{field}}`,
  // deriving a unique field path from the selected text and registering it in
  // the session (the dispatched selection change re-runs syncSelection).
  // Returns the created path so callers can apply extra config on top.
  const makeField = (range?: { from: number; to: number }): string | null => {
    const view = editorViewRef.current;
    if (!view) {
      return null;
    }
    const { from, to } = range ?? view.state.selection;
    if (from === to) {
      return null;
    }
    const text = view.state.doc.textBetween(from, to, " ");
    // Detect the parallel cell before the marker insert shifts positions.
    const sibling = findSiblingCell(view.state, from);
    const base = slugify(text);
    const existing = useTemplateStudioStore.getState().fields;
    let path = base;
    for (let n = 2; existing.some((f) => f.path === path); n++) {
      path = `${base}_${n}`;
    }
    view.dispatch(
      view.state.tr.insertText(`{{${path}}}`, from, to).scrollIntoView(),
    );
    view.focus();
    upsertField(path, {});
    if (sibling !== null) {
      void proposeFieldMirror({ path, sourceText: text, sibling });
    }
    return path;
  };

  // Folio creates its editable PM view lazily (on first focus), so the captured
  // ref can be null if the user opens the Insert menu without clicking into the
  // document first. Ensure + focus the view, then run the insert (next frame if
  // it had to be created).
  const withEditorView = (perform: (view: EditorView) => void) => {
    if (editorViewRef.current) {
      perform(editorViewRef.current);
      return;
    }
    editorRef.current?.ensureEditorView({ focus: true });
    requestAnimationFrame(() => {
      if (editorViewRef.current) {
        perform(editorViewRef.current);
      }
    });
  };

  const insertInline = (text: string) =>
    withEditorView((view) => {
      const { from, to } = view.state.selection;
      // Inserting inside an existing {{marker}} would nest markers and break
      // the grammar; refuse silently (the caret visibly sits in a marker).
      const intersects = getTemplateDirectives(view.state).some(
        (range) => from <= range.to && to >= range.from,
      );
      if (intersects) {
        return;
      }
      view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
      view.focus();
      markDirty();
    });

  // Block directives must occupy their own paragraph (the fill engine anchors
  // them line-by-line). With a selection, wrap the paragraphs it covers in
  // opener/closer; with a caret, insert opener/body/closer after the current
  // paragraph. Either way the placeholder name ends up selected, so typing
  // renames it immediately.
  const insertOrWrapBlock = (
    open: string,
    close: string,
    placeholder: string,
    range?: { from: number; to: number },
  ) =>
    withEditorView((view) => {
      const { state } = view;
      const paragraph = state.schema.nodes["paragraph"];
      if (!paragraph) {
        return;
      }
      const para = (text: string) => markerParagraph(state, paragraph, text);
      const selectPlaceholder = (tr: Transaction, openStart: number) => {
        const namePos = openStart + 1 + open.indexOf(placeholder);
        return tr.setSelection(
          TextSelection.create(tr.doc, namePos, namePos + placeholder.length),
        );
      };
      const { from, to } = range ?? state.selection;
      try {
        if (from === to) {
          const $from = state.doc.resolve(from);
          const pos =
            $from.depth >= 1
              ? $from.after(paragraphDepth($from, paragraph))
              : state.doc.content.size;
          view.dispatch(
            selectPlaceholder(
              state.tr.insert(pos, [para(open), para(""), para(close)]),
              pos,
            ).scrollIntoView(),
          );
        } else {
          const $from = state.doc.resolve(from);
          const $to = state.doc.resolve(to);
          const start =
            $from.depth >= 1
              ? $from.before(paragraphDepth($from, paragraph))
              : 0;
          const end =
            $to.depth >= 1
              ? $to.after(paragraphDepth($to, paragraph))
              : state.doc.content.size;
          const tr = state.tr
            .insert(end, para(close))
            .insert(start, para(open));
          view.dispatch(selectPlaceholder(tr, start).scrollIntoView());
        }
        view.focus();
        markDirty();
      } catch {
        // Selection wasn't in an insertable block context; ignore.
      }
    });

  // Insert a fresh, uniquely-named field at the cursor and register it so it
  // shows in the Fields list right away (rename it there).
  const insertField = () => {
    const existing = useTemplateStudioStore.getState().fields;
    let path = "field";
    for (let n = 2; existing.some((f) => f.path === path); n++) {
      path = `field_${n}`;
    }
    insertInline(`{{${path}}}`);
    upsertField(path, {});
  };

  const insertCondition = (range?: { from: number; to: number }) =>
    insertOrWrapBlock("{{#if condition}}", "{{/if}}", "condition", range);
  const insertLoop = (range?: { from: number; to: number }) =>
    insertOrWrapBlock("{{#each items}}", "{{/each}}", "items", range);
  const insertClause = () => insertInline("{{@clause:Clause}}");

  /** Explicit-click block mirror: wrap the parallel cell's paragraphs in
   *  the same block. The opener's live expression is read at click time via
   *  the synced selected directive (the user typically renames the
   *  placeholder before clicking), so the mirror uses the final name. */
  const applyBlockMirror = (kind: "if" | "each") => {
    const view = editorViewRef.current;
    const { selected } = useTemplateStudioStore.getState();
    const expr = selected?.expr.trim() ?? "";
    if (!view || !selected || selected.kind !== kind || expr === "") {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    const sibling = findSiblingCell(view.state, selected.from);
    const range = sibling === null ? null : siblingWrapRange(sibling);
    if (range === null) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    if (kind === "if") {
      insertOrWrapBlock(`{{#if ${expr}}}`, "{{/if}}", expr, range);
    } else {
      insertOrWrapBlock(`{{#each ${expr}}}`, "{{/each}}", expr, range);
    }
  };

  const offerBlockMirror = (kind: "if" | "each") => {
    stellaToast.add({
      title: t("templates.studio.mirrorBlockOffer"),
      type: "info",
      timeout: MIRROR_OFFER_TOAST_MS,
      action: {
        label: t("templates.studio.mirrorBlockAction"),
        onClick: () => applyBlockMirror(kind),
      },
    });
  };

  /** Wrap-in-condition/loop with the bilingual-mirror offer on top: detect
   *  the parallel cell before the wrap shifts positions, then toast. */
  const wrapBlockWithMirrorOffer = (
    kind: "if" | "each",
    range?: { from: number; to: number },
  ) => {
    const view = editorViewRef.current;
    const anchor = range ?? view?.state.selection;
    const sibling =
      view && anchor !== undefined && anchor.from !== anchor.to
        ? findSiblingCell(view.state, anchor.from)
        : null;
    if (kind === "if") {
      insertCondition(range);
    } else {
      insertLoop(range);
    }
    if (sibling !== null) {
      offerBlockMirror(kind);
    }
  };

  // ── Selection → gesture popover ──────────────────────────
  // Selecting plain prose floats the structural gestures next to the
  // selection: Make field leads, wrap-in-condition / wrap-in-loop follow.
  // After the selection has been stable for a moment, the model proposes a
  // configuration for the would-be field and the Make-field row enriches;
  // the buttons themselves never wait for it.
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const [gesture, setGestureState] = useState<SelectionGesture | null>(null);
  // Mirror for handlers that fire outside the render cycle (debounced
  // callbacks, in-flight enrichment) and need the freshest value.
  const gestureRef = useRef<SelectionGesture | null>(null);
  const setGesture = (next: SelectionGesture | null) => {
    gestureRef.current = next;
    setGestureState(next);
  };
  const [enrichment, setEnrichment] = useState<GestureEnrichment>({
    status: "idle",
  });
  // Bumped on every hide/new fetch so stale enrichment responses are dropped.
  const enrichSeqRef = useRef(0);

  // useCallback (not React Compiler memoization) because the dismiss-listener
  // effect depends on it.
  const hideGesture = useCallback(() => {
    enrichSeqRef.current++;
    gestureRef.current = null;
    setGestureState(null);
    setEnrichment({ status: "idle" });
  }, []);

  const showGesture = useDebouncedCallback((sel: GestureSelection) => {
    const view = editorViewRef.current;
    const host = overlayHostRef.current;
    if (!view || !host) {
      return;
    }
    const { from, to } = view.state.selection;
    if (from === to || from !== sel.from || to !== sel.to) {
      return;
    }
    // Only for selections made in the document itself: while the AI chat bar
    // (or any surface outside the editor) holds focus, stay away.
    const scrollContainer = view.dom.closest("[data-folio-scroll]");
    if (!scrollContainer || !scrollContainer.contains(document.activeElement)) {
      return;
    }
    // Existing {{markers}} have their own inspector faces; the gesture
    // popover is only for plain prose.
    const overlapsDirective = getTemplateDirectives(view.state).some(
      (range) => range.from < to && range.to > from,
    );
    if (overlapsDirective) {
      return;
    }
    // Folio paints the selection highlights asynchronously after the
    // selection change; retry across a few frames until they exist.
    let attempts = 0;
    const read = () => {
      const liveView = editorViewRef.current;
      if (!liveView) {
        return;
      }
      const live = liveView.state.selection;
      if (live.from !== sel.from || live.to !== sel.to) {
        return;
      }
      const rect = getFolioSelectionViewportRect(liveView);
      if (!rect) {
        attempts++;
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
      setGesture({
        ...sel,
        left: Math.min(
          Math.max(center, GESTURE_POPOVER_HALF_WIDTH_PX),
          Math.max(
            GESTURE_POPOVER_HALF_WIDTH_PX,
            host.clientWidth - GESTURE_POPOVER_HALF_WIDTH_PX,
          ),
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

  const fetchGestureSuggestion = async (sel: GestureSelection) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const seq = ++enrichSeqRef.current;
    const contextText = paragraphsAroundSelection(view.state, sel.from);
    // Re-selecting the same text in the same context is common (the popover
    // dismisses on any click); serve the model's previous answer instead of
    // paying for it again.
    const cacheKey = `${sel.text}\u0000${contextText}`;
    const cached = gestureEnrichmentCache.get(cacheKey);
    if (cached !== undefined) {
      setEnrichment(cached);
      return;
    }
    setEnrichment({ status: "loading" });
    const response = await api.templates["suggest-fields"].post({
      text: contextText,
      instructions:
        `The user selected this exact text: "${sel.text}". Propose exactly ` +
        `ONE field for that exact selection (literalText must equal it): ` +
        `its label and input type, plus an aiPrompt only when the selection ` +
        `is free-form prose that AI should draft at fill time.`,
    });
    if (seq !== enrichSeqRef.current) {
      return;
    }
    const match = response.error ? null : response.data.suggestions.at(0);
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
    };
    if (gestureEnrichmentCache.size >= GESTURE_ENRICHMENT_CACHE_MAX) {
      const oldest = gestureEnrichmentCache.keys().next().value;
      if (oldest !== undefined) {
        gestureEnrichmentCache.delete(oldest);
      }
    }
    gestureEnrichmentCache.set(cacheKey, ready);
    setEnrichment(ready);
  };

  const enrichGesture = useDebouncedCallback((sel: GestureSelection) => {
    const shown = gestureRef.current;
    if (shown === null || shown.from !== sel.from || shown.to !== sel.to) {
      return;
    }
    void fetchGestureSuggestion(sel);
  }, GESTURE_ENRICH_DELAY_MS);

  const onGestureSelectionChange = (sel: GestureSelection) => {
    if (sel.text.trim() === "") {
      showGesture.cancel();
      enrichGesture.cancel();
      hideGesture();
      return;
    }
    const shown = gestureRef.current;
    if (shown !== null && (shown.from !== sel.from || shown.to !== sel.to)) {
      hideGesture();
    }
    showGesture(sel);
    enrichGesture(sel);
  };

  // Each button acts on the selection captured when the popover anchored, so
  // a click can never target a drifted live selection.
  const applyGesture = (kind: "field" | "if" | "each" | "clause") => {
    const shown = gestureRef.current;
    if (shown === null) {
      return;
    }
    const range = { from: shown.from, to: shown.to };
    if (kind === "field") {
      const path = makeField(range);
      if (path !== null && enrichment.status === "ready") {
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
    } else if (kind === "clause") {
      withEditorView((view) => {
        const slotName = slugify(
          view.state.doc.textBetween(range.from, range.to, " "),
        );
        view.dispatch(
          view.state.tr
            .insertText(`{{@clause:${slotName}}}`, range.from, range.to)
            .scrollIntoView(),
        );
        view.focus();
        markDirty();
      });
    } else if (kind === "if") {
      wrapBlockWithMirrorOffer("if", range);
    } else {
      wrapBlockWithMirrorOffer("each", range);
    }
    showGesture.cancel();
    enrichGesture.cancel();
    hideGesture();
  };

  // Escape, any scroll, and the (custom) context menu all dismiss the
  // popover: the selection survives, only the floating affordance leaves.
  const gestureShown = gesture !== null;
  useEffect(() => {
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
    host?.addEventListener("scroll", dismiss, { capture: true });
    host?.addEventListener("contextmenu", dismiss, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      host?.removeEventListener("scroll", dismiss, { capture: true });
      host?.removeEventListener("contextmenu", dismiss, { capture: true });
    };
  }, [gestureShown, hideGesture]);

  useEffect(
    () => () => {
      showGesture.cancel();
      enrichGesture.cancel();
    },
    [showGesture, enrichGesture],
  );

  // Loop recipes mirror insertOrWrapBlock's caret branch: the opener, one
  // marker paragraph per field, and the closer land after the current
  // paragraph (block directives must occupy their own paragraph).
  const insertRecipeLoopBlock = (loopPath: string, fieldPaths: string[]) =>
    withEditorView((view) => {
      const { state } = view;
      const paragraph = state.schema.nodes["paragraph"];
      if (!paragraph) {
        return;
      }
      const para = (text: string) => markerParagraph(state, paragraph, text);
      const { from } = state.selection;
      const $from = state.doc.resolve(from);
      const pos =
        $from.depth >= 1
          ? $from.after(paragraphDepth($from, paragraph))
          : state.doc.content.size;
      try {
        view.dispatch(
          state.tr
            .insert(pos, [
              para(`{{#each ${loopPath}}}`),
              ...fieldPaths.map((path) => para(`{{${path}}}`)),
              para("{{/each}}"),
            ])
            .scrollIntoView(),
        );
        view.focus();
        markDirty();
      } catch {
        // Selection wasn't in an insertable block context; ignore.
      }
    });

  const insertRecipe = (definition: TemplateRecipeDefinition) => {
    const existing = useTemplateStudioStore.getState().fields;
    const prepared = prepareRecipeInsert(definition, existing);
    if (prepared.loopPath !== null) {
      insertRecipeLoopBlock(
        prepared.loopPath,
        prepared.fields.map((f) => f.path),
      );
    } else {
      insertInline(prepared.fields.map((f) => `{{${f.path}}}`).join(" "));
    }
    for (const field of prepared.fields) {
      upsertField(field.path, field.config);
    }
  };

  const handleSave = async () => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    setIsSaving(true);
    try {
      const bytes = await editor.save();
      if (!bytes) {
        stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
        return;
      }
      const file = new File([bytes], fileName, { type: DOCX_MIME });

      // Persist the edited manifest alongside the bytes in one call; the server
      // re-embeds it (avoids a binary re-embed round-trip that Eden would parse
      // as text and corrupt).
      const { fields, conditions } = useTemplateStudioStore.getState();
      const stored = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .document.post({
          file,
          manifest: JSON.stringify(buildManifest(manifest, fields, conditions)),
        });
      if (stored.error) {
        stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
        return;
      }

      markSaved();
      stellaToast.add({ title: t("templates.templateSaved"), type: "success" });
      void queryClient.invalidateQueries({
        queryKey: knowledgeKeys.templates.all(activeOrganizationId),
      });
    } catch {
      stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
    } finally {
      setIsSaving(false);
    }
  };

  actionsRef.current = {
    toggleDirectives: () => setShowDirectives((v) => !v),
    insertExistingField: (path) => {
      withEditorView((view) => {
        const { from, to } = view.state.selection;
        view.dispatch(
          view.state.tr.insertText(`{{${path}}}`, from, to).scrollIntoView(),
        );
        view.focus();
        markDirty();
        if (from !== to) {
          // Replacing concrete text with a reused field means this spot's
          // wording may need to differ (declension); let AI fit it.
          const field = useTemplateStudioStore
            .getState()
            .fields.find((f) => f.path === path);
          if (field && field.aiPrompt === undefined && !field.aiAdapt) {
            upsertField(path, { aiAdapt: true });
          }
        }
      });
    },
    setFillPreview: (values) => {
      fillPreviewRef.current = values;
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      setTemplatePreviewValues(
        view,
        values === null
          ? null
          : { values, mode: showDirectives ? "highlighted" : "plain" },
      );
    },
    insertField,
    insertCondition,
    insertLoop,
    insertClause,
    insertRecipe,
    insertClauseSlot: (slotName) => insertInline(`{{@clause:${slotName}}}`),
    makeField: () => {
      makeField();
    },
    save: () => void handleSave(),
    focusAdjacentField: (direction) => {
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      const placeholders = getTemplateDirectives(view.state)
        .filter((d) => d.kind === "placeholder")
        .toSorted((a, b) => a.from - b.from);
      if (placeholders.length === 0) {
        return;
      }
      const head = view.state.selection.from;
      const currentIndex = placeholders.findIndex(
        (d) => head >= d.from && head <= d.to,
      );
      let nextIndex: number;
      if (currentIndex === -1) {
        nextIndex = direction > 0 ? 0 : placeholders.length - 1;
      } else {
        nextIndex =
          (currentIndex + direction + placeholders.length) %
          placeholders.length;
      }
      const target = placeholders.at(nextIndex);
      if (!target) {
        return;
      }
      const $pos = view.state.doc.resolve(
        Math.min(target.from + 2, view.state.doc.content.size),
      );
      view.dispatch(
        view.state.tr.setSelection(TextSelection.near($pos)).scrollIntoView(),
      );
      view.focus();
    },
    focusField: (path) => {
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      const target = getTemplateDirectives(view.state)
        .filter((d) => d.kind === "placeholder" && d.expr === path)
        .toSorted((a, b) => a.from - b.from)
        .at(0);
      if (target) {
        actionsRef.current?.focusPosition(target.from);
      }
    },
    focusPosition: (pos) => {
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      const $pos = view.state.doc.resolve(
        Math.min(pos + 2, view.state.doc.content.size),
      );
      view.dispatch(
        view.state.tr.setSelection(TextSelection.near($pos)).scrollIntoView(),
      );
      view.focus();
    },
    renameFieldPath: (oldPath, newPath) => {
      const view = editorViewRef.current;
      const trimmed = newPath.trim();
      if (!view || trimmed === oldPath) {
        return false;
      }
      const taken = useTemplateStudioStore
        .getState()
        .fields.some((f) => f.path === trimmed);
      if (!isFieldPath(trimmed) || taken) {
        return false;
      }
      // Rewrite every {{oldPath}} marker, last occurrence first so earlier
      // positions stay valid while the transaction accumulates.
      const positional = buildPositionalText(view.state.doc);
      const literal = `{{${oldPath}}}`;
      const ranges: { from: number; to: number }[] = [];
      let idx = positional.text.indexOf(literal);
      while (idx !== -1) {
        ranges.push({
          from: positional.pmPositionAt(idx),
          to: positional.pmPositionAt(idx + literal.length - 1) + 1,
        });
        idx = positional.text.indexOf(literal, idx + literal.length);
      }
      const first = ranges.at(0);
      if (first !== undefined) {
        const tr = view.state.tr;
        for (const range of ranges.toReversed()) {
          tr.insertText(`{{${trimmed}}}`, range.from, range.to);
        }
        // Park the caret inside the first rewritten marker (its `from` is
        // unaffected by the later-position edits above) so the selection
        // sync re-derives the inspector face with the new path right away;
        // without this the face keeps showing the stale path.
        tr.setSelection(
          TextSelection.near(
            tr.doc.resolve(Math.min(first.from + 2, tr.doc.content.size)),
          ),
        ).scrollIntoView();
        // No view.focus(): the dispatched selection refreshes the face, and
        // keeping DOM focus in the inspector lets Tab continue through the
        // field's form instead of jumping into the document.
        view.dispatch(tr);
      }
      useTemplateStudioStore.getState().renameField(oldPath, trimmed);
      markDirty();
      return true;
    },
    rewriteConditionExpr: (next) => {
      const view = editorViewRef.current;
      const { selected } = useTemplateStudioStore.getState();
      const trimmed = next.trim();
      if (
        !view ||
        !selected ||
        (selected.kind !== "if" && selected.kind !== "elseif") ||
        trimmed === "" ||
        /[{}]/u.test(trimmed)
      ) {
        return false;
      }
      if (trimmed === selected.expr) {
        return true;
      }
      const token = selected.kind === "if" ? "#if" : "#elseif";
      const tr = view.state.tr.insertText(
        `{{${token} ${trimmed}}}`,
        selected.from,
        selected.to,
      );
      // Keep the caret inside the rewritten opener so the condition face
      // stays open on the (re-scanned) directive.
      tr.setSelection(
        TextSelection.near(
          tr.doc.resolve(Math.min(selected.from + 2, tr.doc.content.size)),
        ),
      );
      view.dispatch(tr);
      markDirty();
      return true;
    },
    deselect: () => {
      const view = editorViewRef.current;
      const { selected } = useTemplateStudioStore.getState();
      if (view && selected) {
        // A caret anywhere inside (or at the edge of) the marker would make
        // syncSelection re-derive the same face; park it just past the range.
        const pos = Math.min(selected.to + 1, view.state.doc.content.size);
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.near(view.state.doc.resolve(pos), 1),
          ),
        );
      }
      setSelected(null);
    },
    suggestFieldConfig: async (path) => {
      const view = editorViewRef.current;
      if (!view) {
        return null;
      }
      const text = buildPositionalText(view.state.doc).text;
      const response = await api.templates["suggest-fields"].post({
        text: paragraphsAround(text, `{{${path}}}`),
        instructions:
          `Configure the existing field {{${path}}}: propose its label, ` +
          `input type and a realistic exampleValue based on how it is used ` +
          `in the document. Return that field first.`,
      });
      if (response.error) {
        return null;
      }
      const match =
        response.data.suggestions.find((s) => s.fieldPath === path) ??
        response.data.suggestions.at(0);
      if (!match) {
        return null;
      }
      return {
        label: match.label,
        inputType:
          match.inputType !== undefined && isInputType(match.inputType)
            ? match.inputType
            : undefined,
        aiPrompt: match.aiPrompt,
        exampleValue: match.exampleValue,
      };
    },
  };

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.previewFailed")}
        </p>
      </div>
    );
  }
  if (isLoading || !docBuffer) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* `relative` so the floating AI bar, stepper, and selection-gesture
          popover anchor over the doc. */}
      <div className="relative min-h-0 flex-1" ref={overlayHostRef}>
        <div
          className="h-full [scrollbar-gutter:stable] overflow-auto"
          ref={containerRef}
        >
          <Suspense fallback={null}>
            <DocxEditor
              ref={editorRef}
              autoOpenReviewSidebar={false}
              className="h-full"
              documentBuffer={docBuffer}
              initialZoom={fitZoom}
              loadingIndicator={null}
              onChange={markDirty}
              onEditorViewReady={(view) => {
                // Folio re-reports null on some re-renders; keep the last live
                // view so selection syncing doesn't lose its reference.
                if (view) {
                  editorViewRef.current = view;
                  setLiveEditorView(view);
                  setOutline(buildOutline(getTemplateDirectives(view.state)));
                }
              }}
              onCustomContextAction={(id, range) => {
                if (id === MAKE_FIELD_CONTEXT_ID) {
                  makeField(range);
                }
                if (id === WRAP_IF_CONTEXT_ID) {
                  wrapBlockWithMirrorOffer("if", range);
                }
                if (id === WRAP_EACH_CONTEXT_ID) {
                  wrapBlockWithMirrorOffer("each", range);
                }
              }}
              customContextMenuItems={makeFieldContextItems}
              onSelectionChange={(state) => {
                setHasSelection(state?.hasSelection ?? false);
                syncSelection();
              }}
              onSelectionTextChange={onGestureSelectionChange}
              showTemplateDirectives={showDirectives}
            />
          </Suspense>
        </div>
        {gesture !== null && (
          <SelectionGesturePopover
            enrichment={enrichment}
            gesture={gesture}
            onMakeClause={() => applyGesture("clause")}
            onMakeField={() => applyGesture("field")}
            onWrapEach={() => applyGesture("each")}
            onWrapIf={() => applyGesture("if")}
          />
        )}
        <TemplateStudioChat
          editorRef={editorRef}
          editorView={liveEditorView}
          ensureView={forceEditorView}
          fileName={fileName}
          getView={getEditorView}
          templateId={templateId}
        />
      </div>
    </div>
  );
};

// ── Global inspector tab ─────────────────────────────────

// The template settings live as a single tab in the app's right-side
// inspector. The page (above) owns the document + actions and seeds the shared
// session store this view reads from. `close-on-route-leave` is a backstop; the
// page also closes the tab on unmount.
/** The paragraph containing the marker plus one paragraph on each side:
 *  enough context for the model to read how the field is used at the spot
 *  where it was created, without sending the whole document. */
const paragraphsAround = (text: string, marker: string): string => {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.includes(marker));
  if (index === -1) {
    return text;
  }
  return lines
    .slice(Math.max(0, index - 1), index + 2)
    .filter((line) => line.trim() !== "")
    .join("\n");
};

/** The selection's containing paragraph plus one paragraph on each side —
 *  the same context window `paragraphsAround` sends for an existing marker,
 *  read from the live doc because the field marker does not exist yet. */
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

/** Popover buttons act on the captured selection; preventing mousedown keeps
 *  focus (and the painted selection) in the editor while clicking. */
const keepEditorFocus = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

/** Floating gesture menu anchored under (or above) the painted selection.
 *  Instant structural actions first; the Make-field row enriches in place
 *  once the model's proposal arrives. */
const SelectionGesturePopover = ({
  gesture,
  enrichment,
  onMakeField,
  onWrapIf,
  onWrapEach,
  onMakeClause,
}: {
  gesture: SelectionGesture;
  enrichment: GestureEnrichment;
  onMakeField: () => void;
  onWrapIf: () => void;
  onWrapEach: () => void;
  onMakeClause: () => void;
}) => {
  const t = useTranslations();
  return (
    <div
      aria-label={t("templates.studio.insert")}
      className="bg-popover text-popover-foreground absolute z-30 flex w-56 flex-col rounded-lg border p-1 shadow-lg/5 transition-opacity duration-100 starting:opacity-0"
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
      <GestureMakeFieldRow enrichment={enrichment} onMakeField={onMakeField} />
      <Button
        className="justify-start gap-2 font-normal"
        onClick={onWrapIf}
        onMouseDown={keepEditorFocus}
        size="sm"
        variant="ghost"
      >
        <SplitIcon className="text-muted-foreground size-3.5 shrink-0" />
        {t("templates.studio.showOnlyIf")}
      </Button>
      <Button
        className="justify-start gap-2 font-normal"
        onClick={onWrapEach}
        onMouseDown={keepEditorFocus}
        size="sm"
        variant="ghost"
      >
        <RepeatIcon className="text-muted-foreground size-3.5 shrink-0" />
        {t("templates.studio.repeatForEach")}
      </Button>
      <Button
        className="justify-start gap-2 font-normal"
        onClick={onMakeClause}
        onMouseDown={keepEditorFocus}
        size="sm"
        variant="ghost"
      >
        <span className="text-muted-foreground w-3.5 shrink-0 text-center text-xs font-semibold">
          {"\u00a7"}
        </span>
        {t("templates.studio.scopeClause")}
      </Button>
    </div>
  );
};

/** The popover's primary row. Plain "Make field" instantly; once the model's
 *  proposal lands it reads as the suggested label + type icon (wand = AI).
 *  While the proposal is in flight only a subtle shimmer shows — the button
 *  itself stays clickable throughout. */
const GestureMakeFieldRow = ({
  enrichment,
  onMakeField,
}: {
  enrichment: GestureEnrichment;
  onMakeField: () => void;
}) => {
  const t = useTranslations();
  if (enrichment.status === "ready") {
    const TypeIcon =
      enrichment.inputType === undefined
        ? null
        : VALUE_TYPE_META[inputTypeValueKind(enrichment.inputType)].icon;
    const label =
      enrichment.label !== undefined && enrichment.label !== ""
        ? enrichment.label
        : t("templates.studio.makeField");
    return (
      <Button
        className="justify-start gap-2 font-normal"
        onClick={onMakeField}
        onMouseDown={keepEditorFocus}
        size="sm"
        title={t("templates.studio.makeField")}
        variant="ghost"
      >
        <WandSparklesIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        {TypeIcon === null ? null : (
          <TypeIcon className="text-muted-foreground ms-auto size-3.5 shrink-0" />
        )}
      </Button>
    );
  }
  return (
    <Button
      className="justify-start gap-2 font-normal"
      onClick={onMakeField}
      onMouseDown={keepEditorFocus}
      size="sm"
      variant="ghost"
    >
      <BracesIcon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {t("templates.studio.makeField")}
      </span>
      {enrichment.status === "loading" ? (
        <span
          aria-hidden="true"
          className="bg-muted ms-auto h-1.5 w-8 shrink-0 animate-pulse rounded-full"
        />
      ) : null}
    </Button>
  );
};

/** A paragraph node carrying marker text ("" for the empty body line). */
const markerParagraph = (
  state: EditorState,
  paragraph: NodeType,
  text: string,
) => paragraph.create(null, text.length > 0 ? state.schema.text(text) : null);

/** Anchor at the nearest enclosing paragraph, not the top-level block:
 *  inside a table, depth 1 is the whole table and wrapping there would
 *  swallow it. The fill engine expands per paragraph wherever it lives
 *  (including inside a cell), so the markers belong next to the lines. */
const paragraphDepth = ($pos: ResolvedPos, paragraph: NodeType): number => {
  for (let depth = $pos.depth; depth >= 1; depth--) {
    if ($pos.node(depth).type === paragraph) {
      return depth;
    }
  }
  return 1;
};

// ── Bilingual mirroring: sibling-cell detection ──────────

/** A text-bearing cell parallel to a gesture's cell — same table row,
 *  and the only other cell in it with text (two-column bilingual docs).
 *  `from`/`to` span the cell's content; `text` is built from the same
 *  positional-text model the suggestion anchoring searches, so it can be
 *  used as a scope/needle there verbatim. */
type SiblingCell = { cell: PMNode; from: number; to: number; text: string };

const isTableCellNodeName = (name: string) =>
  name === "tableCell" || name === "tableHeader";

const findSiblingCell = (
  state: EditorState,
  pos: number,
): SiblingCell | null => {
  const $pos = state.doc.resolve(pos);
  let cellDepth = 0;
  for (let depth = $pos.depth; depth >= 1; depth--) {
    if (isTableCellNodeName($pos.node(depth).type.name)) {
      cellDepth = depth;
      break;
    }
  }
  if (cellDepth < 2 || $pos.node(cellDepth - 1).type.name !== "tableRow") {
    return null;
  }
  const row = $pos.node(cellDepth - 1);
  const rowStart = $pos.start(cellDepth - 1);
  const cellIndex = $pos.index(cellDepth - 1);
  const siblings: SiblingCell[] = [];
  let offset = 0;
  for (let index = 0; index < row.childCount; index++) {
    const cell = row.child(index);
    if (index !== cellIndex && cell.textContent.trim() !== "") {
      const from = rowStart + offset + 1;
      const to = from + cell.content.size;
      siblings.push({
        cell,
        from,
        to,
        text: buildPositionalText(state.doc, from, to).text,
      });
    }
    offset += cell.nodeSize;
  }
  // Only an unambiguous twin qualifies: with several text-bearing siblings
  // the parallel column can't be picked reliably.
  if (siblings.length !== 1) {
    return null;
  }
  return siblings.at(0) ?? null;
};

/** Positions inside the sibling cell's first and last paragraphs, so
 *  `insertOrWrapBlock` expands the wrap to exactly the cell's paragraphs. */
const siblingWrapRange = (
  sibling: SiblingCell,
): { from: number; to: number } | null => {
  const { cell } = sibling;
  if (
    cell.firstChild?.type.name !== "paragraph" ||
    cell.lastChild?.type.name !== "paragraph"
  ) {
    return null;
  }
  return { from: sibling.from + 1, to: sibling.to - 1 };
};

/** Folds the flat directive scan into the document's nesting: if/each
 *  markers open groups that own everything up to their closer, so the
 *  panel mirrors which fields only appear under a condition or repeat. */
const buildOutline = (directives: readonly DirectiveRange[]): OutlineNode[] => {
  const root: OutlineNode[] = [];
  const stack: OutlineNode[][] = [root];
  const top = () => stack.at(-1) ?? root;
  for (const d of directives.toSorted((a, b) => a.from - b.from)) {
    if (d.kind === "placeholder") {
      top().push({ type: "field", path: d.expr, from: d.from });
    } else if (d.kind === "clause") {
      top().push({ type: "clause", name: d.expr, from: d.from });
    } else if (d.kind === "if" || d.kind === "each") {
      const group: OutlineNode = {
        type: "group",
        kind: d.kind,
        expr: d.expr,
        from: d.from,
        children: [],
      };
      top().push(group);
      stack.push(group.children);
    } else if (d.kind === "elseif" || d.kind === "else") {
      // A branch closes the previous branch and opens a sibling group.
      if (stack.length > 1) {
        stack.pop();
      }
      const group: OutlineNode = {
        type: "group",
        kind: d.kind,
        expr: d.expr,
        from: d.from,
        children: [],
      };
      top().push(group);
      stack.push(group.children);
    } else if (
      (d.kind === "endif" || d.kind === "endeach") &&
      stack.length > 1
    ) {
      stack.pop();
    }
  }
  return root;
};

const outlineFieldPaths = (nodes: OutlineNode[]): Set<string> => {
  const paths = new Set<string>();
  const walk = (list: OutlineNode[]) => {
    for (const node of list) {
      if (node.type === "field") {
        paths.add(node.path);
      }
      if (node.type === "group") {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return paths;
};

/** First marker position per field path, for jump-to-marker rows rendered
 *  outside the outline (the Conditions disclosure's questions). */
const outlineFieldFirstPositions = (
  nodes: OutlineNode[],
): Map<string, number> => {
  const positions = new Map<string, number>();
  const walk = (list: OutlineNode[]) => {
    for (const node of list) {
      if (node.type === "field" && !positions.has(node.path)) {
        positions.set(node.path, node.from);
      }
      if (node.type === "group") {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return positions;
};

type StudioFacet = "fields" | "clauses" | "history" | "fill";

const STUDIO_FACETS: readonly StudioFacet[] = [
  "fields",
  "clauses",
  "history",
  "fill",
];

function TemplateStudioInspectorView({
  tab,
  onClose,
}: InspectorViewRenderProps<TemplateStudioPayload>) {
  const t = useTranslations();
  const { templateId } = tab.payload;
  const [facet, setFacet] = useState<StudioFacet>("fields");
  const sessionTemplateId = useTemplateStudioStore((s) => s.templateId);
  const fields = useTemplateStudioStore((s) => s.fields);
  const conditions = useTemplateStudioStore((s) => s.conditions);
  const outline = useTemplateStudioStore((s) => s.outline);
  const selected = useTemplateStudioStore((s) => s.selected);
  const upsertField = useTemplateStudioStore((s) => s.upsertField);
  const setConditions = useTemplateStudioStore((s) => s.setConditions);

  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const openView = useInspectorStore((s) => s.openView);
  const setNavName = useTemplateNavStore((s) => s.setName);
  const [rename, setRename] = useState<{ active: boolean; value: string }>({
    active: false,
    value: "",
  });

  const commitRename = async () => {
    const next = rename.value.trim();
    setRename({ active: false, value: "" });
    if (!next || next === tab.label) {
      return;
    }
    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .post({ name: next });
    if (response.error) {
      stellaToast.add({ type: "error", title: t("templates.renameFailed") });
      return;
    }
    // Reflect the new name in the tab label, the breadcrumb, and the list.
    openView({
      type: TEMPLATE_STUDIO_VIEW,
      id: templateStudioTabId(templateId),
      label: next,
      payload: { templateId },
      ownerRouteId: TEMPLATES_ROUTE_ID,
    });
    setNavName(next);
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.templates.all(activeOrganizationId),
    });
    stellaToast.add({ type: "success", title: t("templates.templateRenamed") });
  };

  const facetLabels: Record<StudioFacet, string> = {
    fields: t("templates.fields"),
    clauses: t("common.clauses"),
    history: t("common.history"),
    fill: t("templates.testFill"),
  };

  // The page seeds the session on mount; until then (or after it unmounts and
  // clears) the body has nothing to show — but keep the header + subtab row so
  // the tab reads consistently with the rest of the inspector.
  const ready = sessionTemplateId === templateId;

  return (
    <div className="bg-background flex h-full flex-1 flex-col overflow-hidden">
      <InspectorTabHeader
        actions={<StudioSaveAction />}
        label={tab.label}
        onClose={onClose}
        onStartRename={() => setRename({ active: true, value: tab.label })}
        rename={{
          active: rename.active,
          value: rename.value,
          onChange: (value) => setRename({ active: true, value }),
          onCommit: () => void commitRename(),
          onCancel: () => setRename({ active: false, value: "" }),
        }}
      />
      <FacetBar
        facet={facet}
        facets={STUDIO_FACETS}
        labels={facetLabels}
        onChange={(next) => {
          // Re-clicking Fields returns to the template overview.
          if (next === facet && next === "fields") {
            useTemplateStudioStore.getState().actions?.deselect();
          }
          setFacet(next);
        }}
      />
      {!ready && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
        </div>
      )}
      {ready && facet === "fields" && (
        <Inspector
          conditions={conditions}
          fields={fields}
          outline={outline}
          onConditionsChange={setConditions}
          onFieldUpdate={upsertField}
          selected={selected}
        />
      )}
      {ready && facet === "clauses" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <TemplateClausesTab templateId={templateId} />
        </div>
      )}
      {ready && facet === "history" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <TemplateVersionsTab templateId={templateId} />
        </div>
      )}
      {ready && facet === "fill" && (
        <TemplateFillFacet templateId={templateId} />
      )}
      {ready && facet === "fields" && <StudioInsertRow />}
    </div>
  );
}

/** Save lives in the tab's title row; enabled only with unsaved edits. */
const StudioSaveAction = () => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const ui = useTemplateStudioStore((s) => s.ui);
  const isDirty = useTemplateStudioStore((s) => s.isDirty);
  if (!actions) {
    return null;
  }
  return (
    <Button disabled={!isDirty || ui.isSaving} onClick={actions.save} size="xs">
      <SaveIcon className="size-3.5" />
      {t("common.save")}
    </Button>
  );
};

// Filling happens in-place as the "Fill" subtab. It targets the *saved*
// template (the fill endpoint reads from S3). The persisted manifest carries no
// field kind/itemFields, so re-discover the stored DOCX (the same merge the
// fill endpoint uses) to get the real field shape — {{#each}} array fields
// included — rather than reconstructing it from the flat manifest.
const TemplateFillFacet = ({ templateId }: { templateId: string }) => {
  // Leaving the facet clears the in-document preview (and drops any pending
  // lookup-preview response so it cannot re-set a stale preview).
  useEffect(
    () => () => {
      cancelLookupPreviews();
      useTemplateStudioStore.getState().actions?.setFillPreview(null);
    },
    [],
  );
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const detailOptions = templateDetailOptions(activeOrganizationId, templateId);
  const { data: detailData } = useQuery(detailOptions);
  const fillIsDirty = useTemplateStudioStore((s) => s.isDirty);
  const fillActions = useTemplateStudioStore((s) => s.actions);
  const detail =
    detailData && !(detailData instanceof Response) && "manifest" in detailData
      ? detailData
      : null;

  const presignedUrl = detail?.presignedUrl;
  const fileName = detail?.fileName;
  const {
    data: discovered,
    isLoading: discovering,
    isError,
  } = useQuery({
    queryKey: [
      ...detailOptions.queryKey,
      "fill-discover",
      presignedUrl,
      fileName,
    ],
    queryFn: async () => {
      if (presignedUrl === undefined || fileName === undefined) {
        panic("fill tab: saved template document is unavailable");
      }
      const res = await fetch(presignedUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: DOCX_MIME });
      const response = await api.templates.discover.post({ file });
      if (response.error) {
        throw toAPIError(response.error);
      }
      if (response.data instanceof Response) {
        panic("fill tab: discover returned a raw response");
      }
      return response.data;
    },
    enabled: presignedUrl !== undefined && fileName !== undefined,
  });

  if (!detail || discovering) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  if (isError || !discovered) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.loadFailed")}
        </p>
      </div>
    );
  }

  return (
    <>
      {fillIsDirty ? (
        <div className="border-warning/30 bg-warning/10 mx-4 mt-3 flex items-center justify-between gap-2 rounded-lg border p-2.5">
          <p className="text-warning-foreground text-xs">
            {t("templates.studio.fillStale")}
          </p>
          <Button
            onClick={() => fillActions?.save()}
            size="sm"
            variant="outline"
          >
            {t("common.save")}
          </Button>
        </div>
      ) : null}
      <TemplateForm
        conditions={discovered.conditions}
        fields={discovered.fields}
        fileName={detail.fileName}
        onBack={() => undefined}
        onDone={() => undefined}
        onValuesChange={(values) => pushFillPreview(values, discovered.fields)}
        structureErrors={discovered.structureErrors}
        templateId={templateId}
      />
    </>
  );
};

/** Typed fill values become the live in-document preview; composite part
 *  objects join with spaces (the server renders the real format). A lookup
 *  field with a plausible registry number previews the looked-up rendering
 *  instead of the raw number once the debounced lookup-preview response
 *  lands; until then (and on a miss) the raw number stays. */
const pushFillPreview = (
  values: Record<string, unknown>,
  fields?: readonly LookupPreviewField[],
) => {
  cancelLookupPreviews();
  const preview: Record<string, string> = {};
  for (const [path, value] of Object.entries(values)) {
    if (typeof value === "string" && value !== "") {
      preview[path] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      preview[path] = String(value);
    } else if (value !== null && typeof value === "object") {
      const joined = Object.values(value)
        .filter((part): part is string => typeof part === "string")
        .filter((part) => part !== "")
        .join(" ");
      if (joined !== "") {
        preview[path] = joined;
      }
    }
  }
  const pending = applyCachedLookupRenderings(preview, fields ?? []);
  useTemplateStudioStore
    .getState()
    .actions?.setFillPreview(Object.keys(preview).length > 0 ? preview : null);
  if (pending.length > 0) {
    queueLookupPreviews(pending, () => pushFillPreview(values, fields));
  }
};

// ── Lookup live preview ──────────────────────────────────
// A lookup field's live preview shows the deterministic looked-up rendering
// (number → registry hit → the field's [token] format), not the raw number.
// Plausible numbers debounce into POST /templates/lookup-preview; rendered
// text substitutes into the preview map when the response lands.

/** Mirrors the KRS shape check in template-form.tsx (and `validateKrsNumber`
 *  server-side): exactly 10 digits, whitespace-tolerant. */
const LOOKUP_PREVIEW_NUMBER_RE = /^\d{10}$/u;

const normalizeLookupNumber = (value: string): string =>
  value.replaceAll(/\s/gu, "");

type StudioLookup = NonNullable<StudioField["lookup"]>;

type LookupPreviewField = {
  path: string;
  lookup?: StudioLookup | undefined;
};

type LookupPreviewRequest = {
  registry: StudioLookup["registry"];
  number: string;
  format: string | null;
};

const lookupPreviewKey = (request: LookupPreviewRequest): string =>
  `${request.registry} ${request.number} ${request.format ?? ""}`;

/** Rendered previews keyed registry+number+format so repeats are instant;
 *  null marks a known miss (typo'd number, registry outage) that keeps the
 *  raw number without refetch loops. Bounded: past the cap the oldest
 *  insertion is evicted, so a long studio session cannot grow it without
 *  limit. */
const LOOKUP_PREVIEW_CACHE_MAX = 100;
const lookupPreviewCache = new Map<string, string | null>();

const rememberLookupRendering = (key: string, rendered: string | null) => {
  if (lookupPreviewCache.size >= LOOKUP_PREVIEW_CACHE_MAX) {
    const oldest = lookupPreviewCache.keys().next().value;
    if (oldest !== undefined) {
      lookupPreviewCache.delete(oldest);
    }
  }
  lookupPreviewCache.set(key, rendered);
};

const LOOKUP_PREVIEW_DEBOUNCE_MS = 500;
let lookupPreviewSeq = 0;
let lookupPreviewTimer: ReturnType<typeof setTimeout> | undefined;

/** Invalidate the debounce and any in-flight responses; every preview push
 *  (and preview-surface unmount) starts here so only the latest push can
 *  apply its renderings. */
const cancelLookupPreviews = () => {
  lookupPreviewSeq += 1;
  clearTimeout(lookupPreviewTimer);
};

/** Substitute cached renderings into `preview` in place and return the
 *  requests that still need the endpoint. */
const applyCachedLookupRenderings = (
  preview: Record<string, string>,
  fields: readonly LookupPreviewField[],
): LookupPreviewRequest[] => {
  const pending: LookupPreviewRequest[] = [];
  for (const field of fields) {
    const lookup = field.lookup;
    const raw = preview[field.path];
    if (lookup === undefined || raw === undefined) {
      continue;
    }
    const number = normalizeLookupNumber(raw);
    if (!LOOKUP_PREVIEW_NUMBER_RE.test(number)) {
      continue;
    }
    const request: LookupPreviewRequest = {
      registry: lookup.registry,
      number,
      format: lookup.aiFormat ?? null,
    };
    const cached = lookupPreviewCache.get(lookupPreviewKey(request));
    if (cached === undefined) {
      pending.push(request);
    } else if (cached !== null) {
      preview[field.path] = cached;
    }
  }
  return pending;
};

/** Debounced fetch of the pending renderings into the cache; `onResolved`
 *  re-runs the push (which now substitutes synchronously) unless a newer
 *  push superseded this one. */
const queueLookupPreviews = (
  requests: readonly LookupPreviewRequest[],
  onResolved: () => void,
) => {
  const seq = lookupPreviewSeq;
  clearTimeout(lookupPreviewTimer);
  lookupPreviewTimer = setTimeout(() => {
    void (async () => {
      const resolved = await Promise.all(
        requests.map(async (request) => {
          const response = await api.templates["lookup-preview"].post({
            registry: request.registry,
            number: request.number,
            format: request.format,
          });
          // A miss keeps the raw number in the preview (cached as null so
          // it is not refetched); the fill submit reports the real error.
          const rendered =
            !response.error && !(response.data instanceof Response)
              ? response.data.rendered
              : null;
          rememberLookupRendering(lookupPreviewKey(request), rendered);
          return rendered !== null;
        }),
      );
      if (seq === lookupPreviewSeq && resolved.some(Boolean)) {
        onResolved();
      }
    })();
  }, LOOKUP_PREVIEW_DEBOUNCE_MS);
};

/** Single-field variant for the field face: a lookup field's preview shows
 *  the looked-up rendering via the same debounce + cache as the fill facet. */
const pushSingleFieldPreview = (field: StudioField, value: string) => {
  cancelLookupPreviews();
  const { actions } = useTemplateStudioStore.getState();
  if (value === "") {
    actions?.setFillPreview(null);
    return;
  }
  const preview: Record<string, string> = { [field.path]: value };
  const pending = applyCachedLookupRenderings(preview, [field]);
  actions?.setFillPreview(preview);
  if (pending.length > 0) {
    queueLookupPreviews(pending, () => pushSingleFieldPreview(field, value));
  }
};

/** Document actions row — rendered in the inspector tab's top area; the page
 *  registers the handlers + UI state in the session store. */
const StudioInsertRow = () => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const fields = useTemplateStudioStore((s) => s.fields);
  const sessionTemplateId = useTemplateStudioStore((s) => s.templateId);
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  // Linked clauses feed the Insert > Clause slot submenu so the user picks a
  // real clause instead of typing a slot name into a bare {{@clause:...}}.
  const { data: clausesData } = useQuery({
    ...templateClausesOptions(activeOrganizationId, sessionTemplateId ?? ""),
    enabled: sessionTemplateId !== null,
  });
  // Saved recipes (org-wide) feed the Insert > Recipes submenu.
  const { data: recipesData } = useQuery(
    templateRecipesOptions(activeOrganizationId),
  );
  const recipes =
    recipesData && "recipes" in recipesData ? recipesData.recipes : [];
  const linkedClauses =
    clausesData && "links" in clausesData && Array.isArray(clausesData.links)
      ? clausesData.links.flatMap(
          (link: {
            id: string;
            slotName: string | null;
            clause: { title: string } | null;
          }) =>
            link.clause
              ? [
                  {
                    id: link.id,
                    slotName: link.slotName,
                    title: link.clause.title,
                  },
                ]
              : [],
        )
      : [];
  if (!actions) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 border-t px-2",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <Button
        className="flex-1 justify-start"
        onClick={actions.insertField}
        size="sm"
        variant="ghost"
      >
        <PlusIcon />
        {t("templates.studio.newField")}
      </Button>
      <Menu>
        <MenuTrigger
          aria-label={t("templates.studio.insert")}
          render={<Button size="icon-sm" variant="ghost" />}
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {fields.length > 0 && (
            <MenuSub>
              <MenuSubTrigger>
                <BracesIcon />
                {t("templates.fields")}
              </MenuSubTrigger>
              <MenuSubPopup>
                {fields.map((f) => (
                  <MenuItem
                    key={f.path}
                    onClick={() => actions.insertExistingField(f.path)}
                  >
                    <span className="min-w-0 truncate">
                      {f.label === "" ? f.path : f.label}
                    </span>
                    <code className="text-muted-foreground ms-auto ps-3 text-[10px]">
                      {f.path}
                    </code>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          )}
          <MenuItem onClick={actions.insertCondition}>
            <SplitIcon />
            {t("templates.studio.scopeCondition")}
          </MenuItem>
          <MenuItem onClick={actions.insertLoop}>
            <RepeatIcon />
            {t("templates.studio.loop")}
          </MenuItem>
          {recipes.length > 0 && (
            <MenuSub>
              <MenuSubTrigger>
                <BookmarkIcon />
                {t("templates.studio.recipes")}
              </MenuSubTrigger>
              <MenuSubPopup>
                {recipes.map((recipe) => (
                  <MenuItem
                    key={recipe.id}
                    onClick={() => actions.insertRecipe(recipe.definition)}
                  >
                    <span className="min-w-0 truncate">{recipe.name}</span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          )}
          <MenuSub>
            <MenuSubTrigger>
              <span className="text-sm font-semibold">{"\u00a7"}</span>
              {t("templates.studio.scopeClause")}
            </MenuSubTrigger>
            <MenuSubPopup>
              {linkedClauses.map((link) => (
                <MenuItem
                  key={link.id}
                  onClick={() =>
                    actions.insertClauseSlot(
                      link.slotName ?? slugify(link.title),
                    )
                  }
                >
                  {link.title}
                </MenuItem>
              ))}
              {linkedClauses.length > 0 && <MenuSeparator />}
              <MenuItem onClick={actions.insertClause}>
                {t("templates.studio.emptyClauseSlot")}
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
        </MenuPopup>
      </Menu>
    </div>
  );
};

const TemplateStudioRailIcon = (
  _props: InspectorRailIconProps<TemplateStudioPayload>,
) => <BracesIcon size={SIDE_RAIL_TAB_ICON_SIZE_PX} />;

registerInspectorView<TemplateStudioPayload>({
  navigationPolicy: "close-on-route-leave",
  railIcon: TemplateStudioRailIcon,
  render: TemplateStudioInspectorView,
  type: TEMPLATE_STUDIO_VIEW,
});

// ── Selection-scoped inspector ───────────────────────────

type InspectorProps = {
  selected: DirectiveRange | null;
  fields: StudioField[];
  outline: OutlineNode[];
  conditions: NameExpr[];
  onFieldUpdate: (path: string, patch: Partial<StudioField>) => void;
  onConditionsChange: (next: NameExpr[]) => void;
};

const Inspector = ({
  selected,
  fields,
  outline,
  conditions,
  onFieldUpdate,
  onConditionsChange,
}: InspectorProps) => {
  if (selected && selected.kind === "placeholder") {
    const field =
      fields.find((f) => f.path === selected.expr) ??
      defaultStudioField(selected.expr);
    return (
      <FieldFace
        field={field}
        key={field.path}
        onUpdate={(patch) => onFieldUpdate(field.path, patch)}
      />
    );
  }

  if (selected && (selected.kind === "if" || selected.kind === "elseif")) {
    return <ConditionFace conditions={conditions} selected={selected} />;
  }

  if (selected && selected.kind === "clause") {
    return <ClauseFace selected={selected} />;
  }

  // Default: whole-template overview. Fields lead (they are what the template
  // is made of); conditions fold into a disclosure of supporting logic.
  const questions = fields.filter((f) => f.inputType === "boolean");
  return (
    <ScrollArea className="min-h-0 flex-1">
      <FieldNavigator fields={fields} outline={outline} />
      <Separator />
      <ConditionsDisclosure
        conditions={conditions}
        onConditionsChange={onConditionsChange}
        outline={outline}
        questions={questions}
      />
    </ScrollArea>
  );
};

/** Settings face for a `{{#if}}` / `{{#elseif}}` opener: the expression is
 *  click-to-edit (rewriting the marker in the document), named conditions
 *  insert as one-click chips, and managing those names happens back on the
 *  template overview. */
const ConditionFace = ({
  selected,
  conditions,
}: {
  selected: DirectiveRange;
  conditions: NameExpr[];
}) => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const named = conditions.filter((c) => c.name !== "");
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ScopeHeader
        onBack={() => actions?.deselect()}
        subtitle={selected.kind}
        title={t("templates.studio.scopeCondition")}
      />
      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("templates.studio.conditionBlockHelp")}
        </p>
        <ConditionExprEditor
          expr={selected.expr}
          key={`${selected.from}:${selected.expr}`}
          onRewrite={(next) => actions?.rewriteConditionExpr(next) ?? false}
        />
        {named.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {named.map((c) => (
              <Button
                className="h-6 px-2 text-xs"
                key={c.name}
                onClick={() => {
                  actions?.rewriteConditionExpr(c.name);
                }}
                size="sm"
                title={c.expression}
                variant="outline"
              >
                {c.name}
              </Button>
            ))}
          </div>
        )}
        <Button
          className="text-muted-foreground self-start"
          onClick={() => actions?.deselect()}
          size="sm"
          variant="ghost"
        >
          {t("templates.studio.manageNamedConditions")}
        </Button>
      </div>
    </ScrollArea>
  );
};

/** Click-to-edit condition expression: commits by rewriting the block
 *  opener's `{{#if …}}` text in the document. */
const ConditionExprEditor = ({
  expr,
  onRewrite,
}: {
  expr: string;
  onRewrite: (next: string) => boolean;
}) => {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(expr);

  const commit = () => {
    if (value.trim() === expr) {
      setEditing(false);
      return;
    }
    if (onRewrite(value)) {
      setEditing(false);
      return;
    }
    stellaToast.add({
      type: "error",
      title: t("templates.studio.invalidExpression"),
    });
  };

  if (!editing) {
    return (
      <button
        className="hover:bg-muted/60 group flex w-full items-center gap-1.5 rounded border px-3 py-2 text-start"
        onClick={() => setEditing(true)}
        title={t("common.edit")}
        type="button"
      >
        <code className="min-w-0 flex-1 truncate text-xs">{expr || "—"}</code>
        <PencilIcon className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    );
  }
  return (
    <Input
      autoFocus
      className="h-8 font-mono text-xs"
      onBlur={commit}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
        }
        if (e.key === "Escape") {
          setValue(expr);
          setEditing(false);
        }
      }}
      value={value}
    />
  );
};

const ClauseFace = ({ selected }: { selected: DirectiveRange }) => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const templateId = useTemplateStudioStore((s) => s.templateId);
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const queryClient = useQueryClient();
  const [linkOpen, setLinkOpen] = useState(false);
  const clausesOptions = templateClausesOptions(
    activeOrganizationId,
    templateId ?? "",
  );
  const { data: linksData } = useQuery({
    ...clausesOptions,
    enabled: templateId !== null,
  });
  const link =
    linksData && "links" in linksData
      ? linksData.links.find((l) => l.slotName === selected.expr)
      : undefined;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ScopeHeader
        onBack={() => actions?.deselect()}
        subtitle={selected.expr}
        title={t("templates.studio.scopeClause")}
      />
      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("templates.studio.clauseSlotHelp")}
        </p>
        {link === undefined ? (
          <p className="text-muted-foreground text-xs">
            {t("clauses.noLinkedClauses")}
          </p>
        ) : (
          <div className="rounded-md border p-2.5 text-sm">
            {link.clause === null ? (
              <span className="text-destructive">
                {t("clauses.clauseDeleted")}
              </span>
            ) : (
              link.clause.title
            )}
          </div>
        )}
        <Button onClick={() => setLinkOpen(true)} size="sm" variant="outline">
          {t("clauses.linkClause")}
        </Button>
      </div>
      {templateId === null ? null : (
        <LinkClauseDialog
          defaultSlotName={selected.expr}
          onLinked={() => {
            void queryClient.invalidateQueries({
              queryKey: clausesOptions.queryKey,
            });
          }}
          onOpenChange={setLinkOpen}
          open={linkOpen}
          templateId={templateId}
        />
      )}
    </ScrollArea>
  );
};

/** Collapsed "Conditions · N" row on the template overview: expands to the
 *  template's yes/no questions (boolean fields) and the named-condition
 *  editor; the ghost plus adds a named condition right away. */
const ConditionsDisclosure = ({
  conditions,
  onConditionsChange,
  outline,
  questions,
}: {
  conditions: NameExpr[];
  onConditionsChange: (next: NameExpr[]) => void;
  outline: OutlineNode[];
  questions: StudioField[];
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const count = conditions.length + questions.length;

  const addCondition = () => {
    onConditionsChange([...conditions, { name: "", expression: "" }]);
    setOpen(true);
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center">
        <button
          aria-expanded={open}
          className="hover:bg-muted flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-start text-xs"
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          {open ? (
            <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span className="text-muted-foreground font-medium">
            {t("templates.conditionsTitle")} · {count}
          </span>
        </button>
        <Button
          aria-label={t("templates.addCondition")}
          onClick={addCondition}
          size="icon-sm"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
      </div>
      {open && (
        <div className="mt-1 flex flex-col gap-2">
          {questions.length > 0 && (
            <div className="flex flex-col">
              <h4 className="text-muted-foreground px-1.5 py-1 text-[11px] font-medium">
                {t("templates.studio.questions")}
              </h4>
              <ul className="flex flex-col">
                {questions.map((field) => (
                  <QuestionRow
                    field={field}
                    key={field.path}
                    outline={outline}
                  />
                ))}
              </ul>
            </div>
          )}
          <NameExprList
            emptyLabel={t("templates.studio.conditionsSectionHelp")}
            items={conditions}
            onChange={onConditionsChange}
          />
        </div>
      )}
    </div>
  );
};

/** A yes/no field listed among the conditions: it is a question in the fill
 *  form, but in the document it exists to switch blocks on and off. */
const QuestionRow = ({
  field,
  outline,
}: {
  field: StudioField;
  outline: OutlineNode[];
}) => {
  const actions = useTemplateStudioStore((s) => s.actions);
  const from = outlineFieldFirstPositions(outline).get(field.path) ?? -1;
  const ToggleIcon = VALUE_TYPE_META.boolean.icon;
  return (
    <li>
      <button
        className="hover:bg-muted group flex w-full items-center gap-2 rounded px-1.5 py-1 text-start text-xs"
        onClick={() => {
          if (from >= 0) {
            actions?.focusPosition(from);
          }
        }}
        title={field.path}
        type="button"
      >
        <ToggleIcon className="text-muted-foreground size-3.5 shrink-0" />
        <FieldRowLabel label={field.label} path={field.path} />
      </button>
    </li>
  );
};

/** Document outline: fields where they sit, condition/loop blocks as
 *  collapsible groups owning what's inside them, clause slots inline.
 *  Every row jumps the document caret to its marker. Yes/no fields are not
 *  listed here; they show under the Conditions disclosure as questions. */
const FieldNavigator = ({
  fields,
  outline,
}: {
  fields: StudioField[];
  outline: OutlineNode[];
}) => {
  // Fields registered in the session but not (yet) placed in the document
  // still deserve a row, appended at root level.
  const placed = outlineFieldPaths(outline);
  const unplaced = fields.filter(
    (f) => !placed.has(f.path) && f.inputType !== "boolean",
  );
  return (
    <div className="px-4 py-3">
      <ul className="flex flex-col">
        {outline.map((node, index) => (
          <OutlineRow fields={fields} key={index} node={node} />
        ))}
        {unplaced.map((f) => (
          <OutlineRow
            fields={fields}
            key={`unplaced-${f.path}`}
            node={{ type: "field", path: f.path, from: -1 }}
          />
        ))}
      </ul>
    </div>
  );
};

const OutlineRow = ({
  node,
  fields,
}: {
  node: OutlineNode;
  fields: StudioField[];
}) => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const [open, setOpen] = useState(true);

  const jump = () => {
    if (node.from >= 0) {
      actions?.focusPosition(node.from);
    }
  };

  if (node.type === "field") {
    const field = fields.find((f) => f.path === node.path);
    // Yes/no fields live under the Conditions disclosure as questions.
    if (field !== undefined && field.inputType === "boolean") {
      return null;
    }
    const Icon =
      field === undefined
        ? VALUE_TYPE_META.text.icon
        : VALUE_TYPE_META[inputTypeValueKind(field.inputType)].icon;
    return (
      <li>
        <button
          className="hover:bg-muted group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-start text-sm"
          onClick={jump}
          title={node.path}
          type="button"
        >
          <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
            <Icon className="size-4" />
          </span>
          <FieldRowLabel label={field?.label ?? ""} path={node.path} />
          {field === undefined ? null : (
            <span className="text-muted-foreground ms-auto flex shrink-0 items-center gap-1.5">
              <FieldCapabilityIcons field={field} />
              <ChevronRightIcon className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
            </span>
          )}
        </button>
      </li>
    );
  }

  if (node.type === "clause") {
    return (
      <li>
        <button
          className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-start text-sm"
          onClick={jump}
          title={t("templates.studio.scopeClause")}
          type="button"
        >
          <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md text-sm font-semibold">
            {"\u00a7"}
          </span>
          <span className="truncate">{node.name}</span>
        </button>
      </li>
    );
  }

  const GroupIcon = node.kind === "each" ? RepeatIcon : SplitIcon;
  const groupTitle =
    node.kind === "each"
      ? t("templates.studio.loop")
      : t("templates.studio.scopeCondition");
  return (
    <li>
      <div className="flex items-center">
        <button
          aria-expanded={open}
          aria-label={groupTitle}
          className="hover:bg-muted text-muted-foreground rounded p-0.5"
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          {open ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </button>
        <button
          className="hover:bg-muted flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-start text-xs"
          onClick={jump}
          title={groupTitle}
          type="button"
        >
          <GroupIcon className="text-muted-foreground size-3.5 shrink-0" />
          <code className="truncate">
            {node.expr === "" ? node.kind : node.expr}
          </code>
        </button>
      </div>
      {open && node.children.length > 0 ? (
        <ul className="border-border ms-2 flex flex-col border-s ps-2">
          {node.children.map((child, index) => (
            <OutlineRow fields={fields} key={index} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
};

/** Row text for an outline/question entry: the label leads; the mono path is
 *  secondary (revealed on hover next to it). A field without a label shows
 *  its path once instead, with a quiet pencil hinting that clicking through
 *  leads to rename. */
const FieldRowLabel = ({ label, path }: { label: string; path: string }) => {
  if (label === "") {
    return (
      <>
        <code className="truncate">{path}</code>
        <PencilIcon className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </>
    );
  }
  return (
    <>
      <span className="truncate">{label}</span>
      <code className="text-muted-foreground min-w-0 truncate text-[10px] opacity-0 transition-opacity group-hover:opacity-100">
        {path}
      </code>
    </>
  );
};

/** Mini-icons marking what a field can do: registry lookup, AI involvement,
 *  formula derivation, and a quiet dot for required. */
const FieldCapabilityIcons = ({ field }: { field: StudioField }) => (
  <>
    {field.lookup === undefined ? null : <LandmarkIcon className="size-3" />}
    {field.aiAdapt ? (
      <span className="flex items-center gap-0.5">
        <UserIcon className="size-3" />
        <WandSparklesIcon className="size-3" />
      </span>
    ) : null}
    {!field.aiAdapt && field.aiPrompt !== undefined ? (
      <WandSparklesIcon className="size-3" />
    ) : null}
    {field.formula === undefined ? null : <SigmaIcon className="size-3" />}
    {field.required ? (
      <span aria-hidden="true" className="size-1 rounded-full bg-current" />
    ) : null}
  </>
);

const ScopeHeader = ({
  title,
  subtitle,
  action,
  onBack,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned control (e.g. the field face's suggest wand). */
  action?: ReactNode;
  /** Renders a leading chevron returning to the template overview. */
  onBack?: () => void;
}) => {
  const t = useTranslations();
  return (
    <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
      {onBack === undefined ? null : (
        <Button
          aria-label={t("common.goBack")}
          className="-ms-1.5 shrink-0 self-start"
          onClick={onBack}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronLeftIcon />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {title}
        </p>
        {subtitle === undefined ? null : (
          <div className="min-w-0 overflow-hidden text-sm">{subtitle}</div>
        )}
      </div>
      {action === undefined ? null : (
        <div className="shrink-0 self-start">{action}</div>
      )}
    </div>
  );
};

/**
 * Field settings face: leads with what the field IS (a blank in the fill
 * form), lets the model propose a configuration, and previews the actual fill
 * control so every setting shows its consequence.
 */
const FieldFace = ({
  field,
  onUpdate,
}: {
  field: StudioField;
  onUpdate: (patch: Partial<StudioField>) => void;
}) => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const fieldCount = useTemplateStudioStore((s) => s.fields.length);
  const [suggesting, setSuggesting] = useState(false);
  const [recipeDialogOpen, setRecipeDialogOpen] = useState(false);
  const [exampleValue, setExampleValue] = useState<string | undefined>(
    undefined,
  );
  const [previewValue, setPreviewValue] = useState("");

  const pushPreview = (value: string) => {
    setPreviewValue(value);
    pushSingleFieldPreview(field, value);
  };

  // Clear the in-document preview when the face leaves or switches fields
  // (cancelling any pending lookup preview so it cannot re-set it).
  useEffect(
    () => () => {
      cancelLookupPreviews();
      useTemplateStudioStore.getState().actions?.setFillPreview(null);
    },
    [field.path],
  );

  const handleSuggest = async () => {
    if (!actions) {
      return;
    }
    setSuggesting(true);
    const config = await actions.suggestFieldConfig(field.path);
    setSuggesting(false);
    if (!config) {
      stellaToast.add({
        type: "error",
        title: t("templates.studio.aiNoFields"),
      });
      return;
    }
    onUpdate({
      ...(config.label !== undefined ? { label: config.label } : {}),
      ...(config.inputType !== undefined
        ? { inputType: config.inputType }
        : {}),
      ...(config.aiPrompt !== undefined ? { aiPrompt: config.aiPrompt } : {}),
    });
    setExampleValue(config.exampleValue);
    if (config.exampleValue !== undefined && previewValue === "") {
      pushPreview(config.exampleValue);
    }
  };

  // The four value sources are mutually exclusive (the manifest validator
  // rejects combinations), so each picker button clears the other three.
  let valueSource: "person" | "textAi" | "ai" | "formula" = "person";
  if (field.formula !== undefined) {
    valueSource = "formula";
  } else if (field.aiAdapt) {
    valueSource = "textAi";
  } else if (field.aiPrompt !== undefined) {
    valueSource = "ai";
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <ScopeHeader
          action={
            <div className="flex items-center gap-0.5">
              <Button
                aria-label={t("common.previous")}
                disabled={fieldCount < 2}
                onClick={() => actions?.focusAdjacentField(-1)}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                aria-label={t("common.next")}
                disabled={fieldCount < 2}
                onClick={() => actions?.focusAdjacentField(1)}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronRightIcon />
              </Button>
              <Button
                aria-label={t("templates.studio.suggestConfig")}
                disabled={suggesting}
                onClick={() => void handleSuggest()}
                size="icon-sm"
                title={t("templates.studio.suggestConfig")}
                variant="ghost"
              >
                {suggesting ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <WandSparklesIcon />
                )}
              </Button>
              <Button
                aria-label={t("templates.studio.saveAsRecipe")}
                onClick={() => setRecipeDialogOpen(true)}
                size="icon-sm"
                title={t("templates.studio.saveAsRecipe")}
                variant="ghost"
              >
                <BookmarkPlusIcon />
              </Button>
            </div>
          }
          onBack={() => actions?.deselect()}
          subtitle={
            <FieldPathEditor
              key={field.path}
              onRename={(next) => {
                if (!actions) {
                  return false;
                }
                return actions.renameFieldPath(field.path, next);
              }}
              path={field.path}
            />
          }
          title={t("templates.studio.scopeField")}
        />
        <p className="text-muted-foreground px-4 py-3 text-xs leading-relaxed">
          {t("templates.studio.fieldHelp")}
        </p>
        <FieldConfigEditor
          embedded
          field={field}
          hideFormulaControl
          onUpdate={onUpdate}
        />
        <div className="flex flex-col gap-2 border-t px-4 py-4">
          <Label className="text-sm">{t("templates.studio.whoFills")}</Label>
          <div className="flex items-center gap-1">
            <Button
              className="flex-1"
              onClick={() =>
                onUpdate({
                  aiPrompt: undefined,
                  aiAdapt: false,
                  formula: undefined,
                })
              }
              size="sm"
              variant={valueSource === "person" ? "secondary" : "ghost"}
            >
              <UserIcon className="size-3.5" />
              {t("templates.studio.filledByPerson")}
            </Button>
            <Button
              className="flex-1"
              onClick={() =>
                onUpdate({
                  aiPrompt: undefined,
                  aiAdapt: true,
                  formula: undefined,
                })
              }
              size="sm"
              variant={valueSource === "textAi" ? "secondary" : "ghost"}
            >
              <UserIcon className="size-3.5" />
              <WandSparklesIcon className="size-3.5" />
              {t("templates.studio.textPlusAi")}
            </Button>
            <Button
              className="flex-1"
              onClick={() =>
                onUpdate({
                  aiPrompt: field.aiPrompt ?? "",
                  aiAdapt: false,
                  formula: undefined,
                })
              }
              size="sm"
              variant={valueSource === "ai" ? "secondary" : "ghost"}
            >
              <WandSparklesIcon className="size-3.5" />
              {t("templates.studio.draftedByAi")}
            </Button>
            <Button
              className="flex-1"
              onClick={() =>
                onUpdate({
                  formula: field.formula ?? "",
                  aiPrompt: undefined,
                  aiAdapt: false,
                  lookup: undefined,
                })
              }
              size="sm"
              variant={valueSource === "formula" ? "secondary" : "ghost"}
            >
              <SigmaIcon className="size-3.5" />
              {t("templates.studio.formula")}
            </Button>
          </div>
          {valueSource === "textAi" ? (
            <p className="text-muted-foreground text-xs leading-relaxed">
              {t("templates.aiAdaptHint")}
            </p>
          ) : null}
          {valueSource === "ai" ? (
            <Textarea
              onChange={(e) => onUpdate({ aiPrompt: e.target.value })}
              placeholder={t("templates.studio.aiPromptPlaceholder")}
              rows={3}
              value={field.aiPrompt}
            />
          ) : null}
          {valueSource === "formula" ? (
            <>
              <Input
                className="h-8 font-mono text-xs"
                onChange={(e) => onUpdate({ formula: e.target.value })}
                placeholder={t("templates.fieldFormulaExpression")}
                value={field.formula}
              />
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t("templates.fieldFormulaExpressionHint")}
              </p>
            </>
          ) : null}
        </div>
      </ScrollArea>
      <FieldPreview
        exampleValue={exampleValue}
        field={field}
        onValueChange={pushPreview}
        value={previewValue}
      />
      <SaveRecipeDialog
        fieldPath={field.path}
        onOpenChange={setRecipeDialogOpen}
        open={recipeDialogOpen}
      />
    </div>
  );
};

/**
 * Save the field's configuration as an org-wide recipe, insertable into any
 * template. When the field's marker sits inside a `{{#each}}` block, the
 * whole block is the recipe: the loop path plus every field used inside it.
 */
const SaveRecipeDialog = ({
  fieldPath,
  open,
  onOpenChange,
}: {
  fieldPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const outline = useTemplateStudioStore((s) => s.outline);
  const fields = useTemplateStudioStore((s) => s.fields);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const definition = buildRecipeDefinition(fieldPath, outline, fields);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      return;
    }
    setSaving(true);
    const response = await api["template-recipes"].put({
      name: trimmed,
      definition,
    });
    setSaving(false);
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.studio.recipeSaveFailed"),
      });
      return;
    }
    stellaToast.add({
      type: "success",
      title: t("templates.studio.recipeSaved"),
    });
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.templateRecipes.all(activeOrganizationId),
    });
    setName("");
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("templates.studio.saveAsRecipe")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            {definition.loop === undefined ? null : (
              <span className="flex items-center gap-1">
                <RepeatIcon className="size-3.5 shrink-0" />
                <code>{definition.loop.path}</code>
              </span>
            )}
            <span>
              {t("templates.fieldCount", { count: definition.fields.length })}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recipe-name">{t("common.name")}</Label>
            <Input
              autoFocus
              id="recipe-name"
              onChange={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void save();
                }
              }}
              value={name}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={name.trim() === "" || saving}
            onClick={() => void save()}
          >
            {saving ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <BookmarkPlusIcon />
            )}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

/** Click-to-edit field path: renames the {{markers}} in the document. */
const FieldPathEditor = ({
  path,
  onRename,
}: {
  path: string;
  onRename: (next: string) => boolean;
}) => {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path);

  const commit = () => {
    if (value.trim() === path) {
      setEditing(false);
      return;
    }
    if (onRename(value)) {
      setEditing(false);
      return;
    }
    stellaToast.add({
      type: "error",
      title: t("templates.studio.renameFieldInvalid"),
    });
  };

  if (!editing) {
    return (
      <button
        className="hover:bg-muted/60 group -ms-1 flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5"
        onClick={() => setEditing(true)}
        title={t("templates.studio.renameField")}
        type="button"
      >
        <code className="truncate text-sm" title={path}>
          {path}
        </code>
        <PencilIcon className="text-muted-foreground size-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    );
  }
  return (
    <Input
      autoFocus
      className="h-7 font-mono text-sm"
      onBlur={commit}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
        }
        if (e.key === "Escape") {
          setValue(path);
          setEditing(false);
        }
      }}
      value={value}
    />
  );
};

/** Live preview of the control this field becomes in the fill form. */
/** Pinned under the field config: type here and the value shows live in the
 *  document, replacing the {{marker}} (orange when the directive overlay is
 *  on, plain when it's off). */
const FieldPreview = ({
  field,
  exampleValue,
  value,
  onValueChange,
}: {
  field: StudioField;
  exampleValue: string | undefined;
  value: string;
  onValueChange: (value: string) => void;
}) => {
  const t = useTranslations();
  const label = field.label || field.path;
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t px-4 py-4">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {t("templates.studio.fillFormPreview")}
      </p>
      <div className="bg-muted/30 flex flex-col gap-1.5 rounded-md border p-3">
        <Label className="text-xs">
          {label}
          {field.required ? " *" : ""}
        </Label>
        <FieldPreviewControl
          exampleValue={exampleValue}
          field={field}
          onValueChange={onValueChange}
          value={value}
        />
      </div>
    </div>
  );
};

const FieldPreviewControl = ({
  field,
  exampleValue,
  value,
  onValueChange,
}: {
  field: StudioField;
  exampleValue: string | undefined;
  value: string;
  onValueChange: (value: string) => void;
}) => {
  // A formula field is derived at fill time; the fill form shows no input.
  if (field.formula !== undefined) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <SigmaIcon className="size-3.5 shrink-0" />
        <code className="min-w-0 truncate">{field.formula || "—"}</code>
      </p>
    );
  }
  if (field.inputType === "textarea") {
    return (
      <Textarea
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={field.hint ?? exampleValue}
        rows={3}
        value={value}
      />
    );
  }
  if (field.inputType === "boolean") {
    return <Checkbox checked={false} />;
  }
  if (field.inputType === "select") {
    return (
      <Input
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={field.hint ?? (field.options.join(" / ") || exampleValue)}
        value={value}
      />
    );
  }
  if (field.inputType === "date") {
    return (
      <Input
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={field.hint ?? exampleValue ?? "2026-01-31"}
        value={value}
      />
    );
  }
  return (
    <Input
      onChange={(e) => onValueChange(e.target.value)}
      placeholder={field.hint ?? exampleValue}
      value={value}
    />
  );
};

/** Editable name/expression pairs (named conditions). Adding rows is the
 *  enclosing disclosure's job; an empty list shows the teaching hint. */
const NameExprList = ({
  items,
  onChange,
  emptyLabel,
}: {
  items: NameExpr[];
  onChange: (next: NameExpr[]) => void;
  emptyLabel: string;
}) => {
  const t = useTranslations();
  const update = (index: number, patch: Partial<NameExpr>) =>
    onChange(
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground px-1.5 text-xs leading-relaxed">
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <div key={index} className="flex flex-col gap-1.5 rounded border p-2">
          <div className="flex items-center gap-1.5">
            <Input
              className="h-8"
              onChange={(e) => update(index, { name: e.target.value })}
              placeholder={t("templates.studio.namePlaceholder")}
              value={item.name}
            />
            <Button
              aria-label={t("common.remove")}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
              size="sm"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </div>
          <Input
            className="h-8 font-mono text-xs"
            onChange={(e) => update(index, { expression: e.target.value })}
            placeholder={t("templates.studio.expressionPlaceholder")}
            value={item.expression}
          />
        </div>
      ))}
    </div>
  );
};

// ── Fit-to-width ─────────────────────────────────────────

// Letter width at 96 DPI (816px); a touch wider than A4 so either page size
// fits without horizontal scroll. Sets only the initial zoom; the editor's own
// zoom control (Ctrl/Cmd+scroll) takes over after.
const DOCX_PAGE_WIDTH = 816;
const FIT_PADDING = 16;
const MIN_ZOOM = 0.25;
const MAX_FIT_ZOOM = 1;

const clampFitZoom = (zoom: number) =>
  Math.max(MIN_ZOOM, Math.min(MAX_FIT_ZOOM, zoom));

const useFitToWidth = () => {
  const [fitZoom, setFitZoom] = useState(MAX_FIT_ZOOM);

  const containerRef = useCallback((node: HTMLElement | null) => {
    if (!node) {
      return undefined;
    }
    const updateZoom = () => {
      const { clientWidth } = node;
      if (clientWidth <= 0) {
        return;
      }
      const available = Math.max(1, clientWidth - FIT_PADDING * 2);
      setFitZoom(
        clampFitZoom(Math.round((available / DOCX_PAGE_WIDTH) * 100) / 100),
      );
    };
    updateZoom();
    const rafId = requestAnimationFrame(updateZoom);
    const observer = new ResizeObserver(updateZoom);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  return { containerRef, fitZoom };
};

// ── Manifest <-> state ───────────────────────────────────

const INPUT_TYPE_VALUES = [
  "text",
  "textarea",
  "number",
  "boolean",
  "date",
  "select",
] as const;

const isInputType = (value: string): value is EditableField["inputType"] =>
  INPUT_TYPE_VALUES.some((type) => type === value);

const trimChar = (value: string, ch: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ch) {
    start++;
  }
  while (end > start && value[end - 1] === ch) {
    end--;
  }
  return value.slice(start, end);
};

// Derive a field path from selected prose: "Jan Kowalski" -> "jan_kowalski".
const slugify = (text: string): string => {
  const collapsed = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_");
  // Long selections make unwieldy paths; the first few words identify the
  // field just as well (the label carries the rest).
  const slug = trimChar(collapsed, "_")
    .split("_")
    .slice(0, 4)
    .join("_")
    .slice(0, 40);
  return slug.length > 0 ? slug : "field";
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const parseFields = (manifest: unknown): StudioField[] => {
  if (!isRecord(manifest) || !Array.isArray(manifest["fields"])) {
    return [];
  }
  const fields: StudioField[] = manifest["fields"]
    .filter(isRecord)
    .map((raw) => {
      const rawType = raw["inputType"];
      const inputType =
        typeof rawType === "string" && isInputType(rawType) ? rawType : "text";
      const field: StudioField = {
        path: typeof raw["path"] === "string" ? raw["path"] : "",
        kind: typeof raw["kind"] === "string" ? raw["kind"] : "string",
        label: typeof raw["label"] === "string" ? raw["label"] : "",
        inputType,
        required: raw["required"] === true,
        options: Array.isArray(raw["options"])
          ? raw["options"].filter((o): o is string => typeof o === "string")
          : [],
        aiPrompt:
          typeof raw["aiPrompt"] === "string" ? raw["aiPrompt"] : undefined,
        aiAdapt: raw["aiAdapt"] === true,
      };
      if (typeof raw["optionsFrom"] === "string") {
        field.optionsFrom = raw["optionsFrom"];
      }
      if (isRecord(raw["lookup"]) && raw["lookup"]["registry"] === "krs") {
        field.lookup = {
          registry: "krs",
          ...(typeof raw["lookup"]["aiFormat"] === "string"
            ? { aiFormat: raw["lookup"]["aiFormat"] }
            : {}),
        };
      }
      if (Array.isArray(raw["parts"]) && typeof raw["format"] === "string") {
        field.parts = parseEditableParts(raw["parts"]);
        field.format = raw["format"];
      }
      if (typeof raw["formula"] === "string") {
        field.formula = raw["formula"];
      }
      if (typeof raw["hint"] === "string") {
        field.hint = raw["hint"];
      }
      const rawDateFormat = raw["dateFormat"];
      if (
        isRecord(rawDateFormat) &&
        typeof rawDateFormat["locale"] === "string"
      ) {
        const style = DATE_FORMAT_STYLES.find(
          (s) => s === rawDateFormat["style"],
        );
        if (style !== undefined) {
          field.dateFormat = { locale: rawDateFormat["locale"], style };
        }
      }
      return field;
    });

  // Mirror the server merge: namespace parents (a path that is only a dotted
  // prefix of others) are not fillable inputs. This keeps the display clean
  // for templates saved before the server fix landed.
  const paths = fields.map((f) => f.path);
  return fields.filter(
    (f) => !paths.some((p) => p !== f.path && p.startsWith(`${f.path}.`)),
  );
};

const parseEditableParts = (raw: unknown[]): EditablePart[] =>
  raw.filter(isRecord).map((part) => ({
    key: typeof part["key"] === "string" ? part["key"] : "",
    label: typeof part["label"] === "string" ? part["label"] : undefined,
    inputType: part["inputType"] === "select" ? "select" : "text",
    options: Array.isArray(part["options"])
      ? part["options"].filter((o): o is string => typeof o === "string")
      : [],
    pattern: typeof part["pattern"] === "string" ? part["pattern"] : undefined,
  }));

const parseConditions = (manifest: unknown): NameExpr[] => {
  if (!isRecord(manifest) || !Array.isArray(manifest["conditions"])) {
    return [];
  }
  return manifest["conditions"].filter(isRecord).map((raw) => ({
    name: typeof raw["name"] === "string" ? raw["name"] : "",
    expression: typeof raw["expression"] === "string" ? raw["expression"] : "",
  }));
};

type ManifestField = {
  path: string;
  inputType: EditableField["inputType"];
  label?: string;
  required?: boolean;
  options?: string[];
  aiPrompt?: string;
  aiAdapt?: boolean;
  parts?: EditablePart[];
  format?: string;
  optionsFrom?: string;
  lookup?: EditableField["lookup"];
  formula?: string;
  hint?: string;
  dateFormat?: EditableField["dateFormat"];
};

/** One session field as it is persisted: only the settings that are
 *  actually set, in the manifest's `FieldMeta` shape. Shared by the
 *  template manifest build and recipe snapshots. */
const studioFieldToManifestField = (f: StudioField): ManifestField => {
  const field: ManifestField = { path: f.path, inputType: f.inputType };
  if (f.label) {
    field.label = f.label;
  }
  if (f.required) {
    field.required = true;
  }
  if (f.options.length > 0) {
    field.options = f.options;
  }
  if (f.hint !== undefined && f.hint.trim() !== "") {
    field.hint = f.hint.trim();
  }
  if (f.dateFormat !== undefined && f.inputType === "date") {
    field.dateFormat = f.dateFormat;
  }
  // A formula is one of the mutually exclusive value sources; the manifest
  // validator rejects it next to aiPrompt/aiAdapt/lookup/parts, and a
  // composite configuration takes precedence (mirrors the wizard's emit).
  const formula = f.parts === undefined ? (f.formula?.trim() ?? "") : "";
  if (formula !== "") {
    field.formula = formula;
    return field;
  }
  if (f.aiPrompt) {
    field.aiPrompt = f.aiPrompt;
  }
  if (f.aiAdapt) {
    field.aiAdapt = true;
  }
  if (f.optionsFrom !== undefined && f.inputType === "select") {
    field.optionsFrom = f.optionsFrom;
  }
  if (f.lookup !== undefined) {
    field.lookup = f.lookup;
  }
  if (f.parts !== undefined && f.parts.length > 0 && f.format) {
    field.parts = f.parts;
    field.format = f.format;
  }
  return field;
};

const buildManifest = (
  original: unknown,
  fields: StudioField[],
  conditions: NameExpr[],
) => {
  const version =
    isRecord(original) && typeof original["version"] === "number"
      ? original["version"]
      : 1;
  return {
    version,
    fields: fields.filter((f) => f.path).map(studioFieldToManifestField),
    conditions: conditions.filter((c) => c.name && c.expression),
  };
};

// ── Recipes (saved structural blocks) ────────────────────

type RecipeField = TemplateRecipeDefinition["fields"][number];

type OutlineGroup = Extract<OutlineNode, { type: "group" }>;

/** Innermost `{{#each}}` group whose subtree contains the field's marker. */
const findEnclosingEachGroup = (
  nodes: OutlineNode[],
  path: string,
  enclosing: OutlineGroup | null,
): OutlineGroup | null => {
  for (const node of nodes) {
    if (node.type === "field" && node.path === path && enclosing !== null) {
      return enclosing;
    }
    if (node.type === "group") {
      const next = node.kind === "each" ? node : enclosing;
      const found = findEnclosingEachGroup(node.children, path, next);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
};

/** Snapshot a recipe from the live session: when the field's marker sits
 *  inside a `{{#each}}` block, the recipe is the whole block (loop path +
 *  every field used inside it); otherwise just this field's config. */
const buildRecipeDefinition = (
  fieldPath: string,
  outline: OutlineNode[],
  fields: StudioField[],
): TemplateRecipeDefinition => {
  const group = findEnclosingEachGroup(outline, fieldPath, null);
  const loopPath =
    group !== null && isFieldPath(group.expr) ? group.expr : null;
  const paths =
    group !== null && loopPath !== null
      ? [...outlineFieldPaths(group.children)]
      : [fieldPath];
  const recipeFields = paths.map((path) => {
    const field =
      fields.find((f) => f.path === path) ?? defaultStudioField(path);
    // The recipe schema is a strict FieldMeta subset without formula; strip
    // it so saving a recipe from a formula field passes boundary validation
    // (the snapshot keeps the field's label and type, the formula stays
    // template-local).
    const { formula: _formula, ...recipeField } =
      studioFieldToManifestField(field);
    return recipeField;
  });
  if (loopPath === null) {
    return { fields: recipeFields };
  }
  return { fields: recipeFields, loop: { path: loopPath } };
};

const nextFreePath = (
  base: string,
  isTaken: (candidate: string) => boolean,
): string => {
  let path = base;
  for (let n = 2; isTaken(path); n++) {
    path = `${base}_${n}`;
  }
  return path;
};

type PreparedRecipeField = { path: string; config: Partial<StudioField> };

type PreparedRecipe = {
  loopPath: string | null;
  fields: PreparedRecipeField[];
};

/** Resolve the recipe's paths against the session so inserting never
 *  clobbers existing fields: a conflicting loop renames its whole namespace
 *  at once (`persons` -> `persons_2`, fields move with it), conflicting
 *  plain fields get a `_2` suffix individually (like makeField). */
const prepareRecipeInsert = (
  definition: TemplateRecipeDefinition,
  existing: StudioField[],
): PreparedRecipe => {
  const taken = new Set(existing.map((f) => f.path));

  let loopPath: string | null = null;
  let mapPath = (path: string): string => path;
  if (definition.loop !== undefined) {
    const base = definition.loop.path;
    loopPath = nextFreePath(base, (candidate) =>
      existing.some(
        (f) => f.path === candidate || f.path.startsWith(`${candidate}.`),
      ),
    );
    const renamed = loopPath;
    mapPath = (path) => {
      if (path === base) {
        return renamed;
      }
      if (path.startsWith(`${base}.`)) {
        return `${renamed}${path.slice(base.length)}`;
      }
      return path;
    };
  }

  const fields: PreparedRecipeField[] = [];
  for (const field of definition.fields) {
    const path = nextFreePath(mapPath(field.path), (candidate) =>
      taken.has(candidate),
    );
    taken.add(path);
    fields.push({ path, config: recipeFieldToStudioPatch(field) });
  }
  return { loopPath, fields };
};

/** The saved recipe field config as an upsertField patch (path excluded:
 *  the prepared, conflict-free path is passed separately). */
const recipeFieldToStudioPatch = (field: RecipeField): Partial<StudioField> => {
  const patch: Partial<StudioField> = {
    label: field.label ?? "",
    inputType: field.inputType ?? "text",
    required: field.required === true,
    options: field.options ?? [],
    aiPrompt: field.aiPrompt,
    aiAdapt: field.aiAdapt === true,
  };
  if (field.optionsFrom !== undefined) {
    patch.optionsFrom = field.optionsFrom;
  }
  if (field.lookup !== undefined) {
    patch.lookup = field.lookup;
  }
  if (field.parts !== undefined && field.format !== undefined) {
    patch.parts = field.parts.map((part) => ({
      key: part.key,
      label: part.label,
      inputType: part.inputType,
      options: part.options ?? [],
      pattern: part.pattern,
    }));
    patch.format = field.format;
  }
  return patch;
};
