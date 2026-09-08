import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BracesIcon, RepeatIcon, SplitIcon } from "lucide-react";
import type { NodeType, Node as PMNode, ResolvedPos } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import type {
  DirectiveKind,
  DirectiveRange,
  DocxEditorRef,
  TemplatePreviewValue,
} from "@stll/folio-react";
import {
  buildPositionalText,
  getTemplateDirectives,
  setTemplatePreviewValues,
} from "@stll/folio-react";
import { isClauseSlotName, isFieldPath } from "@stll/template-conditions";
import { stellaToast } from "@stll/ui/toast";
import "@stll/folio-react/editor.css";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { TemplateRecipeDefinition } from "@/lib/api-contract";
import { optionalArray } from "@/lib/arrays";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { userErrorMessage } from "@/lib/errors/user-safe";
import {
  isTemplateFillDiscoverKey,
  knowledgeKeys,
  templateDocxBufferOptions,
} from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import { forceReflow } from "@/lib/utils";
import "@/routes/_protected.knowledge/-components/template-studio-inspector";
import { inputTypeValueKind } from "@/lib/value-types";
import type { BlockGestureKind } from "@/routes/_protected.knowledge/-components/directive-kinds";
import { markerConfigRewrites } from "@/routes/_protected.knowledge/-components/template-field-filters";
import type { UnplacedField } from "@/routes/_protected.knowledge/-components/template-field-filters";
import {
  clauseSlotMarker,
  conditionBranchTag,
  conditionOpenTag,
  CONDITION_CLOSE_TAG,
  fieldMarker,
  loopOpenTag,
  LOOP_CLOSE_TAG,
  rewriteFieldMarkerPath,
} from "@/routes/_protected.knowledge/-components/template-markers";
import { TemplateStudioChat } from "@/routes/_protected.knowledge/-components/template-studio-chat";
import {
  protectedRouteApi,
  TEMPLATE_STUDIO_VIEW,
  TEMPLATES_ROUTE_ID,
  templateStudioTabId,
} from "@/routes/_protected.knowledge/-components/template-studio-constants";
import { hasUnsavedEditorChanges } from "@/routes/_protected.knowledge/-components/template-studio-dirty";
import {
  nextFreePath,
  parseFields,
  prepareRecipeInsert,
  slugify,
} from "@/routes/_protected.knowledge/-components/template-studio-model";
import { buildOutline } from "@/routes/_protected.knowledge/-components/template-studio-outline";
import { useFitToWidth } from "@/routes/_protected.knowledge/-components/template-studio-preview";
import {
  TemplateStudioSelectionGesture,
  useTemplateStudioSelectionGesture,
} from "@/routes/_protected.knowledge/-components/template-studio-selection-gesture";
import {
  TemplateStudioSlashMenu,
  useTemplateStudioSlashMenu,
} from "@/routes/_protected.knowledge/-components/template-studio-slash-menu";
import {
  defaultStudioField,
  useTemplateStudioStore,
  type StudioActions,
  type StudioField,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import { filledByForFieldMeta } from "@/routes/_protected.knowledge/-components/template-studio-suggestions";

const DocxEditor = lazy(async () => {
  const m = await import("@/components/docx/app-docx-editor");
  return { default: m.DocxEditor };
});

const MAKE_FIELD_CONTEXT_ID = "make-field";
const WRAP_IF_CONTEXT_ID = "wrap-if";
const WRAP_EACH_CONTEXT_ID = "wrap-each";

// Folio creates the editing PM view lazily (on first interaction). Ensure
// it exists, then poll a few frames before giving up, so the chat apply
// path doesn't report "document not editable" on a doc the user never
// clicked into.
const AWAIT_EDITOR_VIEW_MAX_FRAMES = 12;

const awaitEditorViewWithin = async ({
  editor,
  view,
}: {
  editor: RefObject<DocxEditorRef | null>;
  view: RefObject<EditorView | null>;
}): Promise<EditorView | null> => {
  if (view.current) {
    return view.current;
  }
  editor.current?.ensureEditorView({ focus: false });
  return await new Promise<EditorView | null>((resolve) => {
    let frames = 0;
    const poll = (): void => {
      if (view.current || frames >= AWAIT_EDITOR_VIEW_MAX_FRAMES) {
        resolve(view.current);
        return;
      }
      frames += 1;
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
};

/** Replay Folio's outline-jump flash (`folio-outline-flash`) on the directive
 *  covering `pos`: scan the painted runs (`span[data-pm-start..data-pm-end]`)
 *  for the one spanning the position and re-trigger the animation. Runs after a
 *  scroll, so it retries across frames until the paged editor mounts the page. */
const flashDirectiveAt = (view: EditorView, pos: number) => {
  const container = view.dom.closest("[data-folio-scroll]");
  if (!container) {
    return;
  }
  let attempts = 0;
  const run = () => {
    const spans = container.querySelectorAll<HTMLElement>(
      "span[data-pm-start][data-pm-end]",
    );
    for (const span of spans) {
      const start = Number(span.dataset["pmStart"]);
      const end = Number(span.dataset["pmEnd"]);
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= pos &&
        pos < end
      ) {
        delete span.dataset["folioOutlineFlash"];
        forceReflow(span);
        span.dataset["folioOutlineFlash"] = "";
        return;
      }
    }
    attempts += 1;
    if (attempts < 30) {
      requestAnimationFrame(run);
    }
  };
  requestAnimationFrame(run);
};

/** Source-phrase cap for the bilingual-mirror instruction (the suggest
 *  endpoint bounds `instructions` at 2000 chars). */
const MIRROR_SOURCE_MAX_CHARS = 400;
/** Mirror-offer toasts stay long enough to rename the placeholder first. */
const MIRROR_OFFER_TOAST_MS = 10_000;
/** Item key a field gets when it turns repeatable: `lawyer` re-paths to
 *  `lawyer.value` under `{% for … in lawyer %}` — the engine's object-item
 *  convention (a bare `{{ lawyer }}` inside its own loop never substitutes). */
const LOOP_ITEM_KEY = "value";

/** Stand-in names a fresh block insert selects, so typing renames the
 *  condition, the array, or the clause slot immediately. */
const CONDITION_PLACEHOLDER = "condition";
const LOOP_PLACEHOLDER = "items";
const CLAUSE_PLACEHOLDER = "Clause";

/** The first field path not already taken: `field`, then `field_2`, `field_3`… */
const uniqueFieldPath = (base: string, fields: StudioField[]): string => {
  let path = base;
  for (let n = 2; fields.some((field) => field.path === path); n++) {
    path = `${base}_${n}`;
  }
  return path;
};

// True when the caret sits inside a `{% for %}`…`{% endfor %}` body, paired by
// walking sorted directives with a stack. A `for` opener encloses the
// caret when `opener.to <= head` and its matching `endfor.from >= head`.
const caretInForBlock = (state: EditorState): boolean => {
  const head = state.selection.from;
  const directives = getTemplateDirectives(state).toSorted(
    (a, b) => a.from - b.from,
  );
  const stack: DirectiveRange[] = [];
  for (const d of directives) {
    if (d.kind === "for") {
      stack.push(d);
    } else if (d.kind === "endfor") {
      const open = stack.pop();
      if (open !== undefined && open.to <= head && d.from >= head) {
        return true;
      }
    }
  }
  return false;
};

// The innermost opener/closer pair (e.g. `{% if %}`/`{% endif %}` or
// `{% for %}`/`{% endfor %}`) that encloses this field's marker, paired by
// walking the sorted directives like buildOutline does. Returns null when the
// marker is not inside any matching block.
const enclosingDirectivePair = (
  state: EditorState,
  path: string,
  openKind: DirectiveKind,
  closeKind: DirectiveKind,
): { opener: DirectiveRange; closer: DirectiveRange } | null => {
  const directives = getTemplateDirectives(state).toSorted(
    (a, b) => a.from - b.from,
  );
  const marker = directives.find(
    (d) => d.kind === "placeholder" && d.expr === path,
  );
  if (marker === undefined) {
    return null;
  }
  const stack: DirectiveRange[] = [];
  for (const d of directives) {
    if (d.kind === openKind) {
      stack.push(d);
    } else if (d.kind === closeKind) {
      const open = stack.pop();
      if (open !== undefined && open.to <= marker.from && d.from >= marker.to) {
        return { opener: open, closer: d };
      }
    }
  }
  return null;
};

/** What writing the session's configuration into the document produced: the
 *  markers now carry it (with whatever the document could not hold), or there
 *  was no editable view to write into. */
type MarkerProjectionResult =
  | { status: "written"; unplaced: readonly UnplacedField[] }
  | { status: "noEditor" };

/**
 * Template Studio page: the document (Folio) fills the surface, with a slim
 * action bar above it. The whole-template / per-field settings live in a single
 * tab in the global right-side Inspector (registered below), so the document
 * gets the full width. The page seeds a module-level session store the inspector
 * tab reads from, and opens/closes that tab over its own lifetime. Field
 * configuration lives in the markers: the session seeds from the served
 * manifest (a cache the server derives from those markers) and is written back
 * into the document text on save, which stores the bytes as a new version.
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
  const openView = useInspectorTabsStore((s) => s.openView);
  const closeTab = useInspectorTabsStore((s) => s.closeTab);
  const flashTab = useInspectorTabsStore((s) => s.flashTab);

  const [hasSelection, setHasSelection] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showDirectives, setShowDirectives] = useState(true);
  // Latest fill-preview values; re-dispatched when the eye toggles modes
  // (eye on = orange preview accents, eye off = plain final-looking text).
  const fillPreviewRef = useRef<Record<string, TemplatePreviewValue> | null>(
    null,
  );
  // Reactive twin of editorViewRef for children that re-render on view
  // creation (the floating AI bar needs a live prop, not a ref).
  const [liveEditorView, setLiveEditorView] = useState<EditorView | null>(null);
  const handleEditorChange = useCallback(() => {
    if (hasUnsavedEditorChanges(editorRef.current)) {
      markDirty();
    }
  }, [markDirty]);
  // Right-click on selected text offers the structural gestures directly:
  // turn it into a value marker, or wrap it in a condition / loop block.
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
  const awaitEditorView = useCallback(
    async (): Promise<EditorView | null> =>
      awaitEditorViewWithin({
        editor: editorRef,
        view: editorViewRef,
      }),
    [],
  );
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
  useMountEffect(() => {
    setActions({
      toggleDirectives: () => actionsRef.current?.toggleDirectives(),
      insertField: () => actionsRef.current?.insertField(),
      insertCondition: () => actionsRef.current?.insertCondition(),
      insertLoop: () => actionsRef.current?.insertLoop(),
      insertClause: () => actionsRef.current?.insertClause(),
      insertClauseSlot: (slotName) =>
        actionsRef.current?.insertClauseSlot(slotName),
      insertText: (text) => actionsRef.current?.insertText(text),
      isCaretInLoop: () => actionsRef.current?.isCaretInLoop() ?? false,
      makeField: () => actionsRef.current?.makeField(),
      save: async () => (await actionsRef.current?.save()) ?? false,
      renameFieldPath: (oldPath, newPath) =>
        actionsRef.current?.renameFieldPath(oldPath, newPath) ?? false,
      renameClauseSlot: (oldSlot, newSlot) =>
        actionsRef.current?.renameClauseSlot(oldSlot, newSlot) ?? false,
      rewriteConditionExpr: (next) =>
        actionsRef.current?.rewriteConditionExpr(next) ?? false,
      wrapFieldInCondition: (path) =>
        actionsRef.current?.wrapFieldInCondition(path) ?? false,
      rewriteFieldConditionExpr: (path, next) =>
        actionsRef.current?.rewriteFieldConditionExpr(path, next) ?? false,
      unwrapFieldCondition: (path) =>
        actionsRef.current?.unwrapFieldCondition(path) ?? false,
      deselect: () => actionsRef.current?.deselect(),
      focusAdjacentField: (direction) =>
        actionsRef.current?.focusAdjacentField(direction),
      focusField: (path) => actionsRef.current?.focusField(path),
      focusPosition: (pos) => actionsRef.current?.focusPosition(pos),
      focusEditor: () => actionsRef.current?.focusEditor() ?? null,
      setFillPreview: (values) => actionsRef.current?.setFillPreview(values),
      insertExistingField: (path, formatKey) =>
        actionsRef.current?.insertExistingField(path, formatKey),
      insertExistingCondition: (expr) =>
        actionsRef.current?.insertExistingCondition(expr),
      deleteField: (path) => actionsRef.current?.deleteField(path),
      insertRecipe: (definition) =>
        actionsRef.current?.insertRecipe(definition),
      setFieldRepeatable: (path, repeatable) =>
        actionsRef.current?.setFieldRepeatable(path, repeatable) ?? false,
    });
    return () => setActions(null);
  });
  useExternalSyncEffect(() => {
    patchUi({ metaLabel });
  }, [patchUi, metaLabel]);
  useExternalSyncEffect(() => {
    patchUi({ showDirectives });
  }, [patchUi, showDirectives]);
  useExternalSyncEffect(() => {
    patchUi({ hasSelection });
  }, [patchUi, hasSelection]);
  useExternalSyncEffect(() => {
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
  // Freeze the first buffer so a later query refetch cannot re-initialize the
  // editor mid-edit. Guarded render-time adjustment makes that async arrival a
  // single transition without an intermediate empty commit.
  if (loadedBuffer && docBuffer === null) {
    setDocBuffer(loadedBuffer);
  }

  // Seed the shared session from the manifest and open the Fields/Clauses/
  // History tab in the global inspector; tear both down when the page unmounts
  // (leaving the studio). Keyed on templateId so editing the manifest in the
  // tab doesn't re-seed and discard in-progress edits.
  const setupTemplateSession = useLatestCallback(() => {
    init({
      templateId,
      fields: parseFields(manifest),
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
  });
  useExternalSyncEffect(setupTemplateSession, [
    templateId,
    setupTemplateSession,
  ]);

  // The eye toggles the preview between accented and plain rendering.
  useExternalSyncEffect(() => {
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
  useMountEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (useTemplateStudioStore.getState().isDirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  });

  // Folio defers creating the ProseMirror view until first interaction, so
  // onEditorViewReady never fires and the selection->inspector binding can't
  // read directives. Force the view once the document is loaded (the editor
  // mounts lazily, so poll the ref until it's available).
  useExternalSyncEffect(() => {
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
      // Landing in a field marker flashes the studio's rail tab so the
      // user's eye is drawn to where its settings appear.
      if (covering.kind === "placeholder") {
        flashTab(templateStudioTabId(templateId));
      }
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
  }, [setSelected, setOutline, flashTab, templateId]);

  // ── Bilingual mirroring ──────────────────────────────────
  // A structural gesture inside a table cell with exactly one text-bearing
  // sibling cell (two-column bilingual documents) offers repeating the
  // gesture on the parallel cell. Never silent: a field mirror lands as an
  // accept/reject in-document suggestion, a block mirror as a toast action.

  /** Bilingual mirror for Make field: ask the model for the EXACT verbatim
   *  substring of the parallel cell that corresponds to the source phrase,
   *  then queue an accept/reject in-document suggestion replacing it with
   *  the same value marker. No confident verbatim hit, no proposal. */
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
        `exact phrase "${phrase}" became the field ${fieldMarker(path)}. Return ` +
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
          suggestedText: fieldMarker(path),
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
          // per occurrence: unless the value is structural (lookup, formula)
          // or not prose (no letters: IDs, amounts).
          const current = useTemplateStudioStore
            .getState()
            .fields.find((f) => f.path === path);
          if (current === undefined || current.aiAdapt) {
            return;
          }
          const structural =
            current.lookup !== undefined || current.formula !== undefined;
          if (structural || !/\p{L}/u.test(sourceText)) {
            return;
          }
          upsertField(path, { aiAdapt: true });
        },
      },
    ]);
  };

  // The hero gesture: turn the current text selection into a value marker,
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
      view.state.tr.insertText(fieldMarker(path), from, to).scrollIntoView(),
    );
    view.focus();
    upsertField(path, {});
    if (sibling !== null) {
      detached(
        proposeFieldMirror({ path, sourceText: text, sibling }),
        "template-studio.propose-field-mirror",
      );
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
      // Inserting inside an existing marker would nest markers and break
      // the grammar. Strict interior overlap only: a caret parked at a
      // marker's edge is a legitimate insertion point.
      const intersects = getTemplateDirectives(view.state).some(
        (range) => from < range.to && to > range.from,
      );
      if (intersects) {
        stellaToast.add({
          type: "error",
          title: t("templates.studio.noNestedMarkers"),
        });
        return;
      }
      view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
      view.focus();
      markDirty();
    });

  // Replace the selection (or insert at the caret) with an existing field's
  // marker; `range` pins a captured selection (the gesture popover's) so a
  // click can never target a drifted live selection.
  const insertExistingFieldAt = (
    path: string,
    options?: {
      range?: { from: number; to: number } | undefined;
      formatKey?: string | undefined;
    },
  ) =>
    withEditorView((view) => {
      const { from, to } = options?.range ?? view.state.selection;
      // A lookup field's non-default output is addressed by `{{ path.key }}`;
      // the bare `{{ path }}` renders the default (first) format.
      const marker = fieldMarker(
        options?.formatKey === undefined
          ? path
          : `${path}.${options.formatKey}`,
      );
      view.dispatch(
        view.state.tr.insertText(marker, from, to).scrollIntoView(),
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
    allowInline = false,
  ) =>
    withEditorView((view) => {
      const { state } = view;
      const paragraph = state.schema.nodes["paragraph"];
      if (!paragraph) {
        return;
      }
      const para = (text: string) => markerParagraph(state, paragraph, text);
      // Search from the end: the name to rename is the tag's last token, and
      // a `{% for item in item %}` opener repeats it as the loop variable.
      const placeholderOffset = open.lastIndexOf(placeholder);
      const selectPlaceholder = (tr: Transaction, openStart: number) => {
        const namePos = openStart + 1 + placeholderOffset;
        return tr.setSelection(
          TextSelection.create(tr.doc, namePos, namePos + placeholder.length),
        );
      };
      const { from, to } = range ?? state.selection;
      try {
        // Inline condition: a partial selection inside one paragraph wraps the
        // selected text in inline `{% if %}`…`{% endif %}` tags (the fill engine
        // resolves them mid-paragraph), instead of promoting whole paragraphs.
        if (allowInline && from !== to) {
          const $from = state.doc.resolve(from);
          const $to = state.doc.resolve(to);
          const wholeParagraph =
            $from.parentOffset === 0 &&
            $to.parentOffset === $to.parent.content.size;
          if ($from.sameParent($to) && !wholeParagraph) {
            const tr = state.tr.insertText(close, to).insertText(open, from);
            const namePos = from + placeholderOffset;
            view.dispatch(
              tr
                .setSelection(
                  TextSelection.create(
                    tr.doc,
                    namePos,
                    namePos + placeholder.length,
                  ),
                )
                .scrollIntoView(),
            );
            view.focus();
            markDirty();
            return;
          }
        }
        const $from = state.doc.resolve(from);
        if (from === to) {
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
    const path = uniqueFieldPath(
      "field",
      useTemplateStudioStore.getState().fields,
    );
    insertInline(fieldMarker(path));
    upsertField(path, {});
  };

  const insertCondition = (range?: { from: number; to: number }) =>
    insertOrWrapBlock(
      conditionOpenTag(CONDITION_PLACEHOLDER),
      CONDITION_CLOSE_TAG,
      CONDITION_PLACEHOLDER,
      range,
      true,
    );
  // Place an already-defined condition by its expression (an empty expr falls
  // back to the generic placeholder, matching a fresh insert).
  const insertExistingCondition = (expr: string) => {
    const conditionExpr = expr.trim() || "condition";
    insertOrWrapBlock(
      conditionOpenTag(conditionExpr),
      CONDITION_CLOSE_TAG,
      conditionExpr,
      undefined,
      true,
    );
  };
  const insertLoop = (range?: { from: number; to: number }) =>
    insertOrWrapBlock(
      loopOpenTag(LOOP_PLACEHOLDER),
      LOOP_CLOSE_TAG,
      LOOP_PLACEHOLDER,
      range,
      true,
    );
  const insertClause = () => insertInline(clauseSlotMarker(CLAUSE_PLACEHOLDER));

  /** Explicit-click block mirror: wrap the parallel cell's paragraphs in
   *  the same block. The opener's live expression is read at click time via
   *  the synced selected directive (the user typically renames the
   *  placeholder before clicking), so the mirror uses the final name. */
  const applyBlockMirror = (kind: BlockGestureKind) => {
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
      insertOrWrapBlock(
        conditionOpenTag(expr),
        CONDITION_CLOSE_TAG,
        expr,
        range,
        true,
      );
    } else {
      insertOrWrapBlock(loopOpenTag(expr), LOOP_CLOSE_TAG, expr, range, true);
    }
  };

  const offerBlockMirror = (kind: BlockGestureKind) => {
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
    kind: BlockGestureKind,
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

  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const selectionGesture = useTemplateStudioSelectionGesture({
    editorViewRef,
    overlayHostRef,
    makeField,
    insertExistingField: (path, range) =>
      insertExistingFieldAt(path, { range }),
    insertExistingCondition: (conditionName, range) =>
      insertOrWrapBlock(
        conditionOpenTag(conditionName),
        CONDITION_CLOSE_TAG,
        conditionName,
        range,
        true,
      ),
    insertClause: (range) =>
      withEditorView((view) => {
        const slotName = slugify(
          view.state.doc.textBetween(range.from, range.to, " "),
        );
        view.dispatch(
          view.state.tr
            .insertText(clauseSlotMarker(slotName), range.from, range.to)
            .scrollIntoView(),
        );
        view.focus();
        markDirty();
      }),
    wrapBlock: wrapBlockWithMirrorOffer,
    upsertField,
  });
  const slashMenu = useTemplateStudioSlashMenu({
    activeOrganizationId,
    templateId,
    editorViewRef,
    overlayHostRef,
    insertCondition,
    markDirty,
    upsertField,
  });
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
              para(loopOpenTag(loopPath)),
              ...fieldPaths.map((path) => para(fieldMarker(path))),
              para(LOOP_CLOSE_TAG),
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
      insertInline(prepared.fields.map((f) => fieldMarker(f.path)).join(" "));
    }
    for (const field of prepared.fields) {
      upsertField(field.path, field.config);
    }
  };

  /**
   * Write the session's field configuration into the document's markers, so
   * the bytes Folio is about to export carry it: the DOCX is the only store.
   *
   * Runs once per save rather than on every inspector keystroke, which keeps
   * one transaction (and one undo step) per save instead of one per character.
   */
  const projectSessionIntoDocument =
    async (): Promise<MarkerProjectionResult> => {
      // The editable view is created lazily, so a session where the author only
      // touched the inspector has none yet; without it the configuration would
      // silently never reach the bytes.
      const view = await awaitEditorViewWithin({
        editor: editorRef,
        view: editorViewRef,
      });
      if (!view) {
        return { status: "noEditor" };
      }
      const { fields } = useTemplateStudioStore.getState();
      const { rewrites, unplaced } = markerConfigRewrites({
        directives: getTemplateDirectives(view.state),
        fields,
        markerText: ({ from, to }) => view.state.doc.textBetween(from, to),
      });
      if (rewrites.length > 0) {
        const tr = view.state.tr;
        // Highest position first so the earlier ranges stay valid as the
        // transaction accumulates.
        for (const range of rewrites.toSorted((a, b) => b.from - a.from)) {
          tr.insertText(range.text, range.from, range.to);
        }
        view.dispatch(tr);
      }
      return { status: "written", unplaced };
    };

  const handleSave = async (): Promise<boolean> => {
    const editor = editorRef.current;
    if (!editor) {
      return false;
    }
    setIsSaving(true);
    try {
      // Snapshot the pending rename log BEFORE the bytes are produced: a
      // rename made while the save is in flight is not represented in the
      // saved DOCX, so flushing it would move the link row ahead of the
      // stored markers. The log is replaced immutably on append, so this
      // reference holds exactly the steps the saved bytes can contain; steps
      // appended mid-save stay pending for the next save.
      const pendingAtSave =
        useTemplateStudioStore.getState().pendingSlotRenames;
      const projected = await projectSessionIntoDocument();
      if (projected.status === "noEditor") {
        stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
        return false;
      }
      // The document is the only store, so a setting no marker can carry does
      // not survive this save. The bytes are still worth storing; the author
      // hears which field lost what rather than finding out at fill time.
      const unplaced = projected.unplaced.at(0);
      if (unplaced !== undefined) {
        stellaToast.add({
          title: t("templates.templateSaved"),
          description:
            unplaced.reason === "unwritable"
              ? t("templates.studio.fieldSettingBrackets", {
                  fieldPath: unplaced.path,
                })
              : t("templates.studio.fieldWithoutMarker", {
                  fieldPath: unplaced.path,
                }),
          type: "warning",
        });
      }
      const bytes = await editor.save();
      if (!bytes) {
        stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
        return false;
      }
      const file = new File([bytes], fileName, { type: DOCX_MIME });

      // The bytes are the whole record: the markers they carry were just
      // rewritten with the session's configuration, so the server derives the
      // field list from the document it stores.
      const stored = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .document.post({ file });
      if (stored.error) {
        stellaToast.add({
          title: t("templates.saveFailed"),
          description: userErrorMessage(
            stored.error,
            t("common.unexpectedError"),
          ),
          type: "error",
        });
        return false;
      }

      markSaved();

      // Flush deferred link-row slot renames now that the document (with its
      // already-rewritten clause markers) is persisted, so the row
      // rename can never outlive an unsaved document edit. Only the
      // pre-save snapshot flushes; the live log may have grown mid-save.
      const { dropPendingSlotRenames } = useTemplateStudioStore.getState();
      const pendingSlotRenames = pendingAtSave;
      let slotRenameErrorMessage: string | null = null;
      if (pendingSlotRenames.length > 0) {
        // Flush SEQUENTIALLY by replaying the ordered step log in recorded (edit)
        // order. A chained or cyclic reuse of a freed slot name — e.g. a swap
        // (link1 A→C, link2 B→A, link1 C→B) — is only resolvable one step at a
        // time: the collapsed final state can be an unresolvable single-pass
        // order under the per-template unique-slot constraint, so we never
        // collapse. Each step was already validated against the live document
        // when recorded, so the log order is always replayable.
        //
        // On a hard failure STOP (do not skip ahead): a later step may depend on
        // this one freeing its old slot name, so running it out of order would
        // collide. The unresolved suffix stays pending for the next save's
        // retry. A 404 is NOT a failure — the link (or template) is gone
        // mid-session, so the rename target no longer exists and the step is
        // obsolete: drop it and keep replaying.
        const resolvedSteps: typeof pendingSlotRenames = [];
        for (const step of pendingSlotRenames) {
          // A rejected request (network drop) must land in the same retryable
          // path as an error response: letting it escape to the outer catch
          // after markSaved() would leave the pending steps stranded with the
          // Save affordance (gated on isDirty) gone.
          try {
            // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- ordered replay: a later rename reuses the slot name an earlier one frees, and the first hard failure must stop the run
            const patched = await api
              .templates({ templateId: toSafeId<"template">(templateId) })
              .clauses({ linkId: toSafeId<"templateClause">(step.linkId) })
              .patch({ slotName: step.slotName });
            if (patched.error && patched.error.status !== 404) {
              // Capture the first hard failure for a single toast, then stop:
              // this step and everything after it stay pending for the next
              // save.
              slotRenameErrorMessage = userErrorMessage(
                patched.error,
                t("common.unexpectedError"),
              );
            }
          } catch {
            slotRenameErrorMessage = t("common.unexpectedError");
          }
          if (slotRenameErrorMessage !== null) {
            break;
          }
          // Success, or an obsolete (404) step: either way this leading step is
          // resolved and drops out of the log below.
          resolvedSteps.push(step);
        }
        dropPendingSlotRenames(resolvedSteps);
        if (slotRenameErrorMessage !== null) {
          // Re-mark dirty so the Save affordance (gated on isDirty) stays live
          // for the retry; the document itself already saved successfully.
          markDirty();
          stellaToast.add({
            type: "error",
            title: t("common.error"),
            description: slotRenameErrorMessage,
          });
        }
      }
      // Steps appended while the save was in flight (their markers are not in
      // the stored bytes) survive at the tail of the live log; markSaved()
      // above would otherwise hide the Save affordance they need.
      if (useTemplateStudioStore.getState().pendingSlotRenames.length > 0) {
        markDirty();
      }
      // Invalidate the templates subtree (which nests the clauses, check, and
      // preview keys) only AFTER the flush: refetching between the document
      // POST and the link-row PATCHes would observe the intermediate state
      // where the stored DOCX already carries the renamed clause
      // markers but template_clauses.slotName does not, showing a false
      // check-badge mismatch.
      //
      // `fillDiscover` is nested under `detail` but deliberately keyed on the
      // stable template id only, not the rotating presigned URL (see the key
      // comment in -queries.ts): its refetch must run against the *new*
      // detail's URL. Invalidating it in the same pass as `detail` refetches
      // both concurrently, so a still-mounted Fill facet can re-run discovery
      // with the pre-save URL still in its context, discovering the old
      // document's fields. Exclude it here and invalidate it separately once
      // `detail` (and everything else) has settled.
      detached(
        queryClient
          .invalidateQueries({
            queryKey: knowledgeKeys.templates.all(activeOrganizationId),
            predicate: (query) => !isTemplateFillDiscoverKey(query.queryKey),
          })
          .then(
            async () =>
              await queryClient.invalidateQueries({
                queryKey: knowledgeKeys.templates.fillDiscover(
                  activeOrganizationId,
                  templateId,
                ),
              }),
          ),
        "template-studio.invalidate",
      );
      if (slotRenameErrorMessage === null) {
        stellaToast.add({
          title: t("templates.templateSaved"),
          type: "success",
        });
      }
      // Report overall failure when a slot PATCH hard-failed: the document
      // itself saved, but "Save and leave" must stay in the Studio so the
      // still-pending steps (and their retry) are not discarded by the
      // unmount's store reset.
      return slotRenameErrorMessage === null;
    } catch (error) {
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  // Repeatable ON: rename the field to the loop-item convention
  // (`lawyer` → `lawyer.value`, every marker rewritten), then wrap the first
  // marker's containing paragraph in `{% for … in lawyer %}` / `{% endfor %}`.
  // The
  // wrap is paragraph-anchored like insertOrWrapBlock (works inside table
  // cells) but keeps the caret in the marker so the field face stays open.
  const makeFieldRepeatable = (path: string): boolean => {
    const view = editorViewRef.current;
    if (!view || path.includes(".")) {
      return false;
    }
    const placed = getTemplateDirectives(view.state).some(
      (d) => d.kind === "placeholder" && d.expr === path,
    );
    if (!placed) {
      return false;
    }
    const fields = useTemplateStudioStore.getState().fields;
    const itemPath = nextFreePath(`${path}.${LOOP_ITEM_KEY}`, (candidate) =>
      fields.some((f) => f.path === candidate),
    );
    if (actionsRef.current?.renameFieldPath(path, itemPath) !== true) {
      return false;
    }
    const { state } = view;
    const paragraph = state.schema.nodes["paragraph"];
    const marker = getTemplateDirectives(state)
      .filter((d) => d.kind === "placeholder" && d.expr === itemPath)
      .toSorted((a, b) => a.from - b.from)
      .at(0);
    if (!paragraph || marker === undefined) {
      return false;
    }
    // Inline-or-block wrap, matching conditions: an inline marker becomes an
    // inline `{% for %}` (the fill engine resolves these), a whole-paragraph
    // marker promotes to its own opener/closer paragraphs.
    insertOrWrapBlock(
      loopOpenTag(path),
      LOOP_CLOSE_TAG,
      path,
      { from: marker.from, to: marker.to },
      true,
    );
    // The wrap moves the caret into the new opener's placeholder name; park it
    // back inside the item marker so the field face stays open, exactly like
    // wrapFieldInCondition does.
    const reopened = getTemplateDirectives(view.state)
      .filter((d) => d.kind === "placeholder" && d.expr === itemPath)
      .toSorted((a, b) => a.from - b.from)
      .at(0);
    if (reopened !== undefined) {
      actionsRef.current.focusPosition(reopened.from);
    }
    return true;
  };

  // Repeatable OFF: delete the enclosing each's opener/closer paragraphs
  // (only when the loop body holds nothing but this field's markers; the
  // face disables the toggle otherwise) and re-path back to the loop's name.
  const unmakeFieldRepeatable = (path: string): boolean => {
    const view = editorViewRef.current;
    if (!view) {
      return false;
    }
    // Read the loop name first and verify this field actually belongs to it;
    // the shared remover otherwise mirrors unwrapFieldCondition's guard/delete.
    const pair = enclosingDirectivePair(view.state, path, "for", "endfor");
    if (pair === null) {
      return false;
    }
    const loopPath = pair.opener.expr.trim();
    if (!path.startsWith(`${loopPath}.`)) {
      return false;
    }
    const result = removeEnclosingDirectiveParagraphs(path, "for", "endfor");
    if (result === null) {
      return false;
    }
    const fields = useTemplateStudioStore.getState().fields;
    const flatPath = nextFreePath(loopPath, (candidate) =>
      fields.some((f) => f.path === candidate),
    );
    return actionsRef.current?.renameFieldPath(path, flatPath) ?? false;
  };

  // Inline-wrap this field's own marker in `{% if condition %}`…`{% endif %}`. The
  // marker is text inside one paragraph, so insertCondition's inline branch
  // wraps it in place; the field face stays open (the caret remains in the
  // marker). The expression is set straight after via the shared condition
  // builder, which targets the just-created enclosing block by field path.
  const wrapFieldInCondition = (path: string): boolean => {
    const view = editorViewRef.current;
    if (!view) {
      return false;
    }
    const marker = getTemplateDirectives(view.state)
      .filter((d) => d.kind === "placeholder" && d.expr === path)
      .toSorted((a, b) => a.from - b.from)
      .at(0);
    if (marker === undefined) {
      return false;
    }
    insertCondition({ from: marker.from, to: marker.to });
    // The wrap moves the caret into the new opener's placeholder name; park it
    // back inside the field marker so the field face stays open. The opener
    // is inserted before the marker's old start.
    const reopened = getTemplateDirectives(view.state)
      .filter((d) => d.kind === "placeholder" && d.expr === path)
      .toSorted((a, b) => a.from - b.from)
      .at(0);
    if (reopened !== undefined) {
      actionsRef.current?.focusPosition(reopened.from);
    }
    return true;
  };

  // Delete the innermost opener/closer paragraphs enclosing this field's marker,
  // shared by condition-unwrap and loop-unmake. Guarded: the block body must
  // hold nothing but this field's markers. An inline wrap deletes just the
  // marker text; a block wrap (its own paragraph) deletes the whole paragraph.
  // Delete the closer first so the opener's positions stay valid. Returns the
  // pair on success, or null on guard fail / no pair / dispatch throw.
  const removeEnclosingDirectiveParagraphs = (
    path: string,
    openKind: DirectiveKind,
    closeKind: DirectiveKind,
  ): { opener: DirectiveRange; closer: DirectiveRange } | null => {
    const view = editorViewRef.current;
    if (!view) {
      return null;
    }
    const { state } = view;
    const pair = enclosingDirectivePair(state, path, openKind, closeKind);
    if (pair === null) {
      return null;
    }
    const bodyOnlyHasThisField = getTemplateDirectives(state).every(
      (d) =>
        d.from < pair.opener.to ||
        d.to > pair.closer.from ||
        (d.kind === "placeholder" && d.expr === path),
    );
    if (!bodyOnlyHasThisField) {
      return null;
    }
    const paragraph = state.schema.nodes["paragraph"];
    const removalBounds = (d: DirectiveRange) => {
      if (!d.block || !paragraph) {
        return { from: d.from, to: d.to };
      }
      const $pos = state.doc.resolve(d.from);
      if ($pos.depth < 1) {
        return { from: d.from, to: d.to };
      }
      const depth = paragraphDepth($pos, paragraph);
      return { from: $pos.before(depth), to: $pos.after(depth) };
    };
    const closerBounds = removalBounds(pair.closer);
    const openerBounds = removalBounds(pair.opener);
    try {
      // Closer first so the opener's positions stay valid.
      view.dispatch(
        state.tr
          .delete(closerBounds.from, closerBounds.to)
          .delete(openerBounds.from, openerBounds.to),
      );
    } catch {
      return null;
    }
    markDirty();
    return pair;
  };

  // Rewrite the `{% if … %}` opener of the block that encloses this field's
  // marker (re-derived from the live document, so it works whether the block
  // was just created by wrapFieldInCondition or already existed).
  const rewriteFieldConditionExpr = (path: string, next: string): boolean => {
    const view = editorViewRef.current;
    const trimmed = next.trim();
    if (!view || trimmed === "" || /[{}]/u.test(trimmed)) {
      return false;
    }
    const pair = enclosingDirectivePair(view.state, path, "if", "endif");
    if (pair === null) {
      return false;
    }
    if (trimmed === pair.opener.expr.trim()) {
      return true;
    }
    const tr = view.state.tr.insertText(
      conditionOpenTag(trimmed),
      pair.opener.from,
      pair.opener.to,
    );
    // Keep the caret inside this field's marker so the field face stays open.
    const marker = getTemplateDirectives(view.state)
      .filter((d) => d.kind === "placeholder" && d.expr === path)
      .toSorted((a, b) => a.from - b.from)
      .at(0);
    if (marker !== undefined) {
      tr.setSelection(
        TextSelection.near(
          tr.doc.resolve(Math.min(marker.from + 2, tr.doc.content.size)),
        ),
      );
    }
    view.dispatch(tr);
    markDirty();
    return true;
  };

  // Remove the inline `{% if … %}` / `{% endif %}` pair around this field's marker,
  // keeping the field. Guarded: only when the block body holds nothing but
  // this field's marker (the face disables Remove otherwise). Delete the
  // closer first so the opener's positions stay valid.
  const unwrapFieldCondition = (path: string): boolean => {
    const result = removeEnclosingDirectiveParagraphs(path, "if", "endif");
    if (result !== null) {
      actionsRef.current?.focusField(path);
    }
    return result !== null;
  };

  // The studio store registry (mounted once above) holds stable trampolines
  // that dereference actionsRef at call time, so this per-render handler set
  // is pushed into it after commit rather than during render.
  const actions: StudioActions = {
    toggleDirectives: () => setShowDirectives((visible) => !visible),
    deleteField: (path) => {
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      // Delete the scanned marker ranges, not a literal text match: a value
      // marker carries the field's filter chain, so its text is not `{{path}}`.
      const ranges = getTemplateDirectives(view.state)
        .filter((d) => d.kind === "placeholder" && d.expr === path)
        .toSorted((a, b) => a.from - b.from);
      if (ranges.length > 0) {
        const tr = view.state.tr;
        for (const range of ranges.toReversed()) {
          tr.delete(range.from, range.to);
        }
        view.dispatch(tr);
      }
      useTemplateStudioStore.getState().removeField(path);
      markDirty();
      actionsRef.current?.deselect();
    },
    insertExistingField: (path, formatKey) =>
      insertExistingFieldAt(path, { formatKey }),
    insertExistingCondition,
    setFieldRepeatable: (path, repeatable) =>
      repeatable ? makeFieldRepeatable(path) : unmakeFieldRepeatable(path),
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
    insertClauseSlot: (slotName) => insertInline(clauseSlotMarker(slotName)),
    insertText: (text) => insertInline(text),
    isCaretInLoop: () => {
      const view = editorViewRef.current;
      return view !== null && caretInForBlock(view.state);
    },
    makeField: () => {
      makeField();
    },
    save: async () => await handleSave(),
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
      // Step field-by-field, not occurrence-by-occurrence: collapse to each
      // distinct path's FIRST occurrence (placeholders are sorted, so the first
      // seen per path wins) and cycle through those.
      const firstByPath = new Map<string, DirectiveRange>();
      for (const d of placeholders) {
        if (!firstByPath.has(d.expr)) {
          firstByPath.set(d.expr, d);
        }
      }
      const distinct = [...firstByPath.values()];
      const head = view.state.selection.from;
      const currentExpr = placeholders.find(
        (d) => head >= d.from && head <= d.to,
      )?.expr;
      const currentIndex =
        currentExpr === undefined
          ? -1
          : distinct.findIndex((d) => d.expr === currentExpr);
      let nextIndex: number;
      if (currentIndex === -1) {
        nextIndex = direction > 0 ? 0 : distinct.length - 1;
      } else {
        nextIndex =
          (currentIndex + direction + distinct.length) % distinct.length;
      }
      const target = distinct.at(nextIndex);
      if (target) {
        actionsRef.current?.focusPosition(target.from);
      }
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
      view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
      view.focus();
      editorRef.current?.getEditorRef()?.scrollToPosition(pos);
      flashDirectiveAt(view, pos);
    },
    focusEditor: () => {
      const view = editorViewRef.current;
      view?.focus();
      return view?.dom ?? null;
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
      // Rewrite the bare marker plus every keyed lookup marker
      // `{{ oldPath.<formatKey> }}` (a lookup field's non-default formats are
      // addressed by `{{ path.key }}`; the bare marker renders the default).
      // Each marker is re-emitted from its own scanned text, so the filter
      // chain that configures the field survives the rename.
      const renamed = useTemplateStudioStore
        .getState()
        .fields.find((f) => f.path === oldPath);
      const renamePaths = new Map([[oldPath, trimmed]]);
      for (const format of optionalArray(renamed?.lookup?.formats)) {
        renamePaths.set(`${oldPath}.${format.key}`, `${trimmed}.${format.key}`);
      }
      const ranges = getTemplateDirectives(view.state)
        .flatMap((d) => {
          const nextPath =
            d.kind === "placeholder" ? renamePaths.get(d.expr) : undefined;
          if (nextPath === undefined) {
            return [];
          }
          const replacement = rewriteFieldMarkerPath(
            view.state.doc.textBetween(d.from, d.to),
            nextPath,
          );
          return replacement === null
            ? []
            : [{ from: d.from, to: d.to, replacement }];
        })
        .toSorted((a, b) => a.from - b.from);
      const first = ranges.at(0);
      if (first !== undefined) {
        const tr = view.state.tr;
        for (const range of ranges.toReversed()) {
          tr.insertText(range.replacement, range.from, range.to);
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
    renameClauseSlot: (oldSlot, newSlot) => {
      const view = editorViewRef.current;
      const trimmed = newSlot.trim();
      if (!view || trimmed === oldSlot || !isClauseSlotName(trimmed)) {
        return false;
      }
      const clauseDirectives = getTemplateDirectives(view.state).filter(
        (d) => d.kind === "clause",
      );
      // Reject a collision with a different slot already in the document.
      if (
        clauseDirectives.some((d) => d.expr !== oldSlot && d.expr === trimmed)
      ) {
        return false;
      }
      const targets = clauseDirectives.filter((d) => d.expr === oldSlot);
      if (targets.length === 0) {
        return false;
      }
      const tr = view.state.tr;
      // Rewrite highest position first so earlier ranges stay valid as the
      // transaction accumulates. Preserve each marker's version modifier.
      for (const d of targets.toSorted((a, b) => b.from - a.from)) {
        tr.insertText(clauseSlotMarker(trimmed, d.clauseVersion), d.from, d.to);
      }
      // Park the caret inside the first (lowest-position) rewritten marker so
      // selection sync re-derives the clause face with the new slot name.
      let firstFrom = Number.POSITIVE_INFINITY;
      for (const target of targets) {
        firstFrom = Math.min(firstFrom, target.from);
      }
      tr.setSelection(
        TextSelection.near(
          tr.doc.resolve(Math.min(firstFrom + 2, tr.doc.content.size)),
        ),
      );
      view.dispatch(tr);
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
        (selected.kind !== "if" && selected.kind !== "elif") ||
        trimmed === "" ||
        /[{}]/u.test(trimmed)
      ) {
        return false;
      }
      if (trimmed === selected.expr) {
        return true;
      }
      const tr = view.state.tr.insertText(
        selected.kind === "if"
          ? conditionOpenTag(trimmed)
          : conditionBranchTag(trimmed),
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
    wrapFieldInCondition,
    rewriteFieldConditionExpr,
    unwrapFieldCondition,
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
  };
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

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
        <div className="h-full overflow-auto" ref={containerRef}>
          <Suspense fallback={null}>
            <DocxEditor
              ref={editorRef}
              autoOpenReviewSidebar={false}
              className="h-full"
              documentBuffer={docBuffer}
              initialZoom={fitZoom}
              loadingIndicator={null}
              onChange={handleEditorChange}
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
                  wrapBlockWithMirrorOffer("for", range);
                }
              }}
              customContextMenuItems={makeFieldContextItems}
              onSelectionChange={(state) => {
                setHasSelection(state?.hasSelection ?? false);
                syncSelection();
              }}
              onSelectionTextChange={selectionGesture.onSelectionTextChange}
              onSlashMenuChange={slashMenu.onSlashMenuChange}
              onSlashMenuKeyAction={slashMenu.onSlashMenuKeyAction}
              showTemplateDirectives={showDirectives}
            />
          </Suspense>
        </div>
        {slashMenu.renderState !== null && (
          <TemplateStudioSlashMenu {...slashMenu.renderState} />
        )}
        {selectionGesture.renderState !== null && (
          <TemplateStudioSelectionGesture {...selectionGesture.renderState} />
        )}
        <TemplateStudioChat
          editorRef={editorRef}
          editorView={liveEditorView}
          awaitView={awaitEditorView}
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
