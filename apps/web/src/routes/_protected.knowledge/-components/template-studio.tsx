import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BracesIcon, RepeatIcon, SplitIcon } from "lucide-react";
import type { NodeType, Node as PMNode, ResolvedPos } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import type { TemplateRecipeDefinition } from "@stll/api/types";
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
import "@stll/folio-react/editor.css";
import { isClauseSlotName, isFieldPath } from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { useInspectorStore } from "@/components/inspector/inspector-store";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { DOCX_MIME } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { inputTypeValueKind } from "@/lib/value-types";
import { TemplateStudioChat } from "@/routes/_protected.knowledge/-components/template-studio-chat";
import "@/routes/_protected.knowledge/-components/template-studio-inspector";
import {
  protectedRouteApi,
  TEMPLATE_STUDIO_VIEW,
  TEMPLATES_ROUTE_ID,
  templateStudioTabId,
} from "@/routes/_protected.knowledge/-components/template-studio-constants";
import {
  buildManifest,
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
import {
  knowledgeKeys,
  templateDocxBufferOptions,
} from "@/routes/_protected.knowledge/-queries";

const DocxEditor = lazy(async () => {
  const m = await import("@/components/docx/app-docx-editor");
  return { default: m.DocxEditor };
});

const MAKE_FIELD_CONTEXT_ID = "make-field";
const WRAP_IF_CONTEXT_ID = "wrap-if";
const WRAP_EACH_CONTEXT_ID = "wrap-each";

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
        void span.offsetWidth;
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
 *  `lawyer.value` under `{{#each lawyer}}` — the engine's object-item
 *  convention (bare `{{lawyer}}` inside its own loop never substitutes). */
const LOOP_ITEM_KEY = "value";

/** The first field path not already taken: `field`, then `field_2`, `field_3`… */
const uniqueFieldPath = (base: string, fields: StudioField[]): string => {
  let path = base;
  for (let n = 2; fields.some((field) => field.path === path); n++) {
    path = `${base}_${n}`;
  }
  return path;
};

// True when the caret sits inside an `{{#each}}…{{/each}}` body, paired by
// walking sorted directives with a stack. An `each` opener encloses the
// caret when `opener.to <= head` and its matching `endeach.from >= head`.
const caretInEachBlock = (state: EditorState): boolean => {
  const head = state.selection.from;
  const directives = getTemplateDirectives(state).toSorted(
    (a, b) => a.from - b.from,
  );
  const stack: DirectiveRange[] = [];
  for (const d of directives) {
    if (d.kind === "each") {
      stack.push(d);
    } else if (d.kind === "endeach") {
      const open = stack.pop();
      if (open !== undefined && open.to <= head && d.from >= head) {
        return true;
      }
    }
  }
  return false;
};

// The innermost opener/closer pair (e.g. `{{#if}}`/`{{/if}}` or
// `{{#each}}`/`{{/each}}`) that encloses this field's marker, paired by
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
  const flashTab = useInspectorStore((s) => s.flashTab);

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
  // Folio creates the editing PM view lazily (on first interaction), so a
  // freshly opened template has no view until something forces it. Resolve
  // it asynchronously: ensure, then poll a few frames before giving up, so
  // the chat apply path doesn't report "document not editable" on a doc the
  // user never clicked into.
  const awaitEditorView = useCallback(async (): Promise<EditorView | null> => {
    if (editorViewRef.current) {
      return editorViewRef.current;
    }
    editorRef.current?.ensureEditorView({ focus: false });
    return await new Promise<EditorView | null>((resolve) => {
      let frames = 0;
      const poll = () => {
        if (editorViewRef.current || frames >= 12) {
          resolve(editorViewRef.current);
          return;
        }
        frames += 1;
        // eslint-disable-next-line react/react-compiler -- recursive local function flagged as its own dependency; `poll` is not a reactive value and cannot be added to the useCallback deps
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  }, []);
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
  useExternalSyncEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per template; the manifest is the fixed source doc for this templateId and re-seeding would discard edits made in the inspector tab.
  }, [templateId]);

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
      // A lookup field's non-default output is addressed by `{{path.key}}`;
      // the bare `{{path}}` renders the default (first) format.
      const marker =
        options?.formatKey === undefined
          ? `{{${path}}}`
          : `{{${path}.${options.formatKey}}}`;
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
      const selectPlaceholder = (tr: Transaction, openStart: number) => {
        const namePos = openStart + 1 + open.indexOf(placeholder);
        return tr.setSelection(
          TextSelection.create(tr.doc, namePos, namePos + placeholder.length),
        );
      };
      const { from, to } = range ?? state.selection;
      try {
        // Inline condition: a partial selection inside one paragraph wraps the
        // selected text in inline {{#if}}…{{/if}} markers (the fill engine
        // resolves them mid-paragraph), instead of promoting whole paragraphs.
        if (allowInline && from !== to) {
          const $from = state.doc.resolve(from);
          const $to = state.doc.resolve(to);
          const wholeParagraph =
            $from.parentOffset === 0 &&
            $to.parentOffset === $to.parent.content.size;
          if ($from.sameParent($to) && !wholeParagraph) {
            const tr = state.tr.insertText(close, to).insertText(open, from);
            const namePos = from + open.indexOf(placeholder);
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
    insertInline(`{{${path}}}`);
    upsertField(path, {});
  };

  const insertCondition = (range?: { from: number; to: number }) =>
    insertOrWrapBlock("{{#if condition}}", "{{/if}}", "condition", range, true);
  // Place an already-defined condition by its expression (an empty expr falls
  // back to the generic placeholder, matching a fresh insert).
  const insertExistingCondition = (expr: string) => {
    const conditionExpr = expr.trim() || "condition";
    insertOrWrapBlock(
      `{{#if ${conditionExpr}}}`,
      "{{/if}}",
      conditionExpr,
      undefined,
      true,
    );
  };
  const insertLoop = (range?: { from: number; to: number }) =>
    insertOrWrapBlock("{{#each items}}", "{{/each}}", "items", range, true);
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
      insertOrWrapBlock(`{{#if ${expr}}}`, "{{/if}}", expr, range, true);
    } else {
      insertOrWrapBlock(`{{#each ${expr}}}`, "{{/each}}", expr, range, true);
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

  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const selectionGesture = useTemplateStudioSelectionGesture({
    editorViewRef,
    overlayHostRef,
    makeField,
    insertExistingField: (path, range) =>
      insertExistingFieldAt(path, { range }),
    insertExistingCondition: (conditionName, range) =>
      insertOrWrapBlock(
        `{{#if ${conditionName}}}`,
        "{{/if}}",
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
            .insertText(`{{@clause:${slotName}}}`, range.from, range.to)
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
      const bytes = await editor.save();
      if (!bytes) {
        stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
        return false;
      }
      const file = new File([bytes], fileName, { type: DOCX_MIME });

      // Persist the edited manifest alongside the bytes in one call; the server
      // re-embeds it (avoids a binary re-embed round-trip that Eden would parse
      // as text and corrupt).
      const { fields } = useTemplateStudioStore.getState();
      const stored = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .document.post({
          file,
          manifest: JSON.stringify(buildManifest(manifest, fields)),
        });
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
      stellaToast.add({ title: t("templates.templateSaved"), type: "success" });

      // Flush deferred link-row slot renames now that the document (with its
      // already-rewritten {{@clause:...}} markers) is persisted, so the row
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
            // oxlint-disable-next-line no-await-in-loop -- sequential by design: steps must replay in recorded order so each rename lands against the state the prior steps produced, respecting the unique-slot constraint.
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
      // where the stored DOCX already carries the renamed {{@clause:...}}
      // markers but template_clauses.slotName does not, showing a false
      // check-badge mismatch.
      void queryClient.invalidateQueries({
        queryKey: knowledgeKeys.templates.all(activeOrganizationId),
      });
      // Report overall failure when a slot PATCH hard-failed: the document
      // itself saved, but "Save and leave" must stay in the Studio so the
      // still-pending steps (and their retry) are not discarded by the
      // unmount's store reset.
      return slotRenameErrorMessage === null;
    } catch {
      stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  // Repeatable ON: rename the field to the loop-item convention
  // (`lawyer` → `lawyer.value`, every marker rewritten), then wrap the first
  // marker's containing paragraph in `{{#each lawyer}}` / `{{/each}}`. The
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
    // inline {{#each}} (the fill engine resolves these), a whole-paragraph
    // marker promotes to its own opener/closer paragraphs.
    insertOrWrapBlock(
      `{{#each ${path}}}`,
      "{{/each}}",
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
    const pair = enclosingDirectivePair(view.state, path, "each", "endeach");
    if (pair === null) {
      return false;
    }
    const loopPath = pair.opener.expr.trim();
    if (!path.startsWith(`${loopPath}.`)) {
      return false;
    }
    const result = removeEnclosingDirectiveParagraphs(path, "each", "endeach");
    if (result === null) {
      return false;
    }
    const fields = useTemplateStudioStore.getState().fields;
    const flatPath = nextFreePath(loopPath, (candidate) =>
      fields.some((f) => f.path === candidate),
    );
    return actionsRef.current?.renameFieldPath(path, flatPath) ?? false;
  };

  // Inline-wrap this field's own marker in `{{#if condition}}…{{/if}}`. The
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
    // adds `{{#if condition}}` (length below) before the marker's old start.
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

  // Rewrite the `{{#if …}}` opener of the block that encloses this field's
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
      `{{#if ${trimmed}}}`,
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

  // Remove the inline `{{#if …}}` / `{{/if}}` pair around this field's marker,
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

  // eslint-disable-next-line react/react-compiler -- deliberate latest-ref write: the store actions registered once in useMountEffect delegate through actionsRef.current, which must hold this render's fresh handler closures
  actionsRef.current = {
    toggleDirectives: () => setShowDirectives((visible) => !visible),
    deleteField: (path) => {
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      const positional = buildPositionalText(view.state.doc);
      const literal = `{{${path}}}`;
      const ranges: { from: number; to: number }[] = [];
      let idx = positional.text.indexOf(literal);
      while (idx !== -1) {
        ranges.push({
          from: positional.pmPositionAt(idx),
          to: positional.pmPositionAt(idx + literal.length - 1) + 1,
        });
        idx = positional.text.indexOf(literal, idx + literal.length);
      }
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
    insertClauseSlot: (slotName) => insertInline(`{{@clause:${slotName}}}`),
    insertText: (text) => insertInline(text),
    isCaretInLoop: () => {
      const view = editorViewRef.current;
      return view !== null && caretInEachBlock(view.state);
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
      // Rewrite the bare `{{oldPath}}` marker plus every keyed lookup marker
      // `{{oldPath.<formatKey>}}` (a lookup field's non-default formats are
      // addressed by `{{path.key}}`; the bare marker renders the default).
      // Each rewrite carries the path replacement to apply at its range.
      const renamed = useTemplateStudioStore
        .getState()
        .fields.find((f) => f.path === oldPath);
      const renamedFormats = optionalArray(renamed?.lookup?.formats);
      const literals: { literal: string; replacement: string }[] = [
        { literal: `{{${oldPath}}}`, replacement: `{{${trimmed}}}` },
        ...renamedFormats.map((format) => ({
          literal: `{{${oldPath}.${format.key}}}`,
          replacement: `{{${trimmed}.${format.key}}}`,
        })),
      ];
      // Last occurrence first so earlier positions stay valid while the
      // transaction accumulates.
      const positional = buildPositionalText(view.state.doc);
      const ranges: { from: number; to: number; replacement: string }[] = [];
      for (const { literal, replacement } of literals) {
        let idx = positional.text.indexOf(literal);
        while (idx !== -1) {
          ranges.push({
            from: positional.pmPositionAt(idx),
            to: positional.pmPositionAt(idx + literal.length - 1) + 1,
            replacement,
          });
          idx = positional.text.indexOf(literal, idx + literal.length);
        }
      }
      ranges.sort((a, b) => a.from - b.from);
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
        const marker =
          d.clauseVersion === undefined
            ? `{{@clause:${trimmed}}}`
            : `{{@clause:${trimmed}:${d.clauseVersion}}}`;
        tr.insertText(marker, d.from, d.to);
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
