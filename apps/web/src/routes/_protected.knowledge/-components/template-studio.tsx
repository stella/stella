import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RepeatIcon,
  SplitIcon,
  TextQuoteIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { NodeType, Node as PMNode, ResolvedPos } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useDebounce, useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import type { TemplateRecipeDefinition } from "@stll/api/types";
import type {
  DirectiveKind,
  DirectiveRange,
  DocxEditorRef,
  TemplatePreviewValue,
  TemplateSlashMenuKeyAction,
  TemplateSlashMenuState,
} from "@stll/folio-react";
import {
  buildPositionalText,
  clearTemplateSlashMenu,
  consumeTemplateSlashQuery,
  getFolioCaretViewportRect,
  getFolioSelectionViewportRect,
  getTemplateDirectives,
  getTemplateSlashMenu,
  resetTemplateSlashQuery,
  setTemplatePreviewValues,
} from "@stll/folio-react";
import "@stll/folio-react/editor.css";
import {
  isClauseSlotName,
  isFieldPath,
  isSafeFieldPath,
} from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import {
  MenuPreviewLayout,
  PreviewPane,
} from "@stll/ui/components/preview-pane";
import { Separator } from "@stll/ui/components/separator";
import { stellaToast } from "@stll/ui/components/toast";
import { containedHandler } from "@stll/ui/hooks/use-contained-handler";
import { cn } from "@stll/ui/lib/utils";

import { useInspectorStore } from "@/components/inspector/inspector-store";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { BoundedMap } from "@/lib/bounded-set";
import { DOCX_MIME } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { inputTypeValueKind, VALUE_TYPE_META } from "@/lib/value-types";
import { TemplateStudioChat } from "@/routes/_protected.knowledge/-components/template-studio-chat";
import { reusableConditions } from "@/routes/_protected.knowledge/-components/template-studio-condition-source";
import "@/routes/_protected.knowledge/-components/template-studio-inspector";
import {
  protectedRouteApi,
  TEMPLATE_STUDIO_VIEW,
  TEMPLATES_ROUTE_ID,
  templateStudioTabId,
} from "@/routes/_protected.knowledge/-components/template-studio-constants";
import {
  buildManifest,
  isInputType,
  nextFreePath,
  parseFields,
  prepareRecipeInsert,
  sanitizeFieldPath,
  slugify,
} from "@/routes/_protected.knowledge/-components/template-studio-model";
import { buildOutline } from "@/routes/_protected.knowledge/-components/template-studio-outline";
import { useFitToWidth } from "@/routes/_protected.knowledge/-components/template-studio-preview";
import {
  defaultStudioField,
  useTemplateStudioStore,
  type StudioActions,
  type StudioField,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import { filledByForFieldMeta } from "@/routes/_protected.knowledge/-components/template-studio-suggestions";
import type { TemplateEditableField } from "@/routes/_protected.knowledge/-components/template-wizard";
import {
  clausesOptions as clauseLibraryOptions,
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

// ── Selection gesture popover ────────────────────────────

/** Selecting prose settles for this long before the popover shows; drag and
 *  shift+arrow selections re-arm it instead of flashing mid-gesture. */
const GESTURE_SHOW_DELAY_MS = 150;
/** Pause on a stable selection before asking the model to enrich the
 *  Make-field row. The instant buttons never wait for this. */
const GESTURE_ENRICH_DELAY_MS = 500;
const GESTURE_POPOVER_OFFSET_PX = 8;
/** Half the popover's widest layout (menu column + 256px preview pane, capped
 *  at the 30rem/480px max-width), for clamping its centered position inside the
 *  host so it never spills out. */
const GESTURE_POPOVER_HALF_WIDTH_PX = 240;
/** Rough rendered height of the menu + preview, for the above/below flip. */
const GESTURE_POPOVER_EST_HEIGHT_PX = 280;
/** At most this many existing field paths ride along in the enrichment
 *  instruction (the suggest endpoint bounds `instructions` at 2000 chars). */
const GESTURE_ENRICH_MAX_PATHS = 30;
/** Joined-paths character budget inside the enrichment instruction. */
const GESTURE_ENRICH_PATHS_MAX_CHARS = 1000;
/** Source-phrase cap for the bilingual-mirror instruction (the suggest
 *  endpoint bounds `instructions` at 2000 chars). */
const MIRROR_SOURCE_MAX_CHARS = 400;
/** Mirror-offer toasts stay long enough to rename the placeholder first. */
const MIRROR_OFFER_TOAST_MS = 10_000;
/** Item key a field gets when it turns repeatable: `lawyer` re-paths to
 *  `lawyer.value` under `{{#each lawyer}}` — the engine's object-item
 *  convention (bare `{{lawyer}}` inside its own loop never substitutes). */
const LOOP_ITEM_KEY = "value";

/** The live text selection in the document, as reported by Folio. */
type GestureSelection = { from: number; to: number; text: string };

/** A settled selection the gesture popover is anchored to; `left`/`top` are
 *  relative to the page's document wrapper (the popover's offset parent). */
type SelectionGesture = GestureSelection & {
  left: number;
  top: number;
  placement: "above" | "below";
};

// ── Slash-command menu ───────────────────────────────────

/** Gap (px) between the caret and the menu's top-left corner. Kept tiny so the
 *  menu hugs the cursor. */
const SLASH_MENU_OFFSET_PX = 2;
/** Rough rendered height of the menu, for the above/below flip and the
 *  off-screen clamp. */
const SLASH_MENU_EST_HEIGHT_PX = 280;
/** Full rendered menu width, for the off-screen right-edge clamp. The list
 *  column is `w-56` (224px); on `sm`+ screens `MenuPreviewLayout` renders a
 *  `PreviewPane` (`w-64`, 256px) beside it across a 9px gap+border, so the menu
 *  is ~489px wide. Clamp against the whole width so the preview pane never
 *  spills off-screen. */
const SLASH_MENU_LIST_WIDTH_PX = 224;
const SLASH_MENU_PREVIEW_WIDTH_PX = 256 + 9;
const SLASH_MENU_WIDTH_PX =
  SLASH_MENU_LIST_WIDTH_PX + SLASH_MENU_PREVIEW_WIDTH_PX;
/** Tailwind `sm`: below it `MenuPreviewLayout` hides the preview pane, so only
 *  the list column renders and the right-edge clamp must use the list width. */
const SLASH_MENU_PREVIEW_BREAKPOINT_PX = 640;
/** Cap on existing fields offered for reuse so a large template's field list
 *  never turns the menu into an unbounded scroll. */
const SLASH_MENU_MAX_FIELDS = 50;
/** Cap on clause-library rows fetched for the clause submenu. */
const SLASH_MENU_CLAUSE_LIMIT = 50;

/** The open slash menu, positioned at the caret. `left`/`top` are relative to
 *  the overlay host (the menu's offset parent), like the gesture popover. */
type SlashMenu = {
  from: number;
  query: string;
  left: number;
  top: number;
  placement: "above" | "below";
};

/** Which level of the menu is showing. The root lists the creators and the two
 *  submenu openers; `fields` and `clauses` are the reuse submenus. */
type SlashView = "root" | "fields" | "clauses";

/** A top-level row: two direct creators and two submenu openers. */
type SlashRootItem =
  | { kind: "create-field"; path: string }
  | { kind: "create-condition" }
  | { kind: "field"; path: string; label: string }
  | { kind: "open-fields" }
  | { kind: "open-clauses" };

/** A clause-library row in the slash menu's clause submenu. */
type SlashClause = {
  id: string;
  title: string;
  currentVersion: number;
  description: string | null;
};

/** The rows for the active view, tagged so render and the key handler narrow
 *  on `view` without unsafe casts. */
type SlashRows =
  | { view: "root"; items: SlashRootItem[] }
  | { view: "fields"; items: StudioField[] }
  | { view: "clauses"; items: SlashClause[] };

/** The new field's path for a "New field" row. Safe field paths such as
 *  `party.name` / `line-item` are kept verbatim; unsafe or invalid queries fall
 *  back to the sanitizer (`slugify` would strip the `.`/`-` and mangle the name
 *  the user typed). */
const createFieldPathFromQuery = (trimmed: string): string => {
  if (trimmed === "") {
    return "field";
  }
  if (isSafeFieldPath(trimmed)) {
    return trimmed;
  }
  const sanitized = sanitizeFieldPath(trimmed);
  return isSafeFieldPath(sanitized) ? sanitized : "field";
};

/** The first field path not already taken: `field`, then `field_2`, `field_3`…
 *  Shared by the blank `/` create row and the insert-field action so a generic
 *  field can always be added even when `field` already exists. */
const uniqueFieldPath = (base: string, fields: StudioField[]): string => {
  let path = base;
  for (let n = 2; fields.some((field) => field.path === path); n++) {
    path = `${base}_${n}`;
  }
  return path;
};

/** Build the root rows for the current query. The typed text both filters the
 *  rows and (for "New field") becomes the new field's name. */
const buildSlashRootItems = (
  query: string,
  fields: StudioField[],
): SlashRootItem[] => {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const matches = (...keywords: string[]): boolean =>
    keywords.some((kw) => kw.includes(needle));

  // Empty query: browse the grouped entry points (create a field/condition, or
  // open the existing-field / clause submenus). A blank create row offers a
  // fresh unique path (field_2, …) so a generic field can always be added.
  if (trimmed === "") {
    const items: SlashRootItem[] = [
      { kind: "create-field", path: uniqueFieldPath("field", fields) },
      { kind: "create-condition" },
    ];
    if (fields.length > 0) {
      items.push({ kind: "open-fields" });
    }
    items.push({ kind: "open-clauses" });
    return items;
  }

  // Typed query: matching existing fields first (one keystroke/click to reuse),
  // then keyword-matched commands (clause search, condition), then the generic
  // create-new-field fallback last. Order matters: the highlight resets to row 0
  // on each keystroke, so "/if" or "/clause" + Enter must run the command rather
  // than create a field literally named "if"/"clause".
  const createPath = createFieldPathFromQuery(trimmed);
  const reuseExact = fields.some((field) => field.path === createPath);
  const items: SlashRootItem[] = matchingSlashFields(query, fields).map(
    (field) => ({
      kind: "field" as const,
      path: field.path,
      label: field.label === "" ? field.path : field.label,
    }),
  );
  if (matches("clause")) {
    items.push({ kind: "open-clauses" });
  }
  if (matches("condition", "if")) {
    items.push({ kind: "create-condition" });
  }
  if (!reuseExact) {
    items.push({ kind: "create-field", path: createPath });
  }
  return items;
};

/** Fields offered in the "Existing field" submenu, filtered by the submenu
 *  query (the same typed `/` text). */
const matchingSlashFields = (
  query: string,
  fields: StudioField[],
): StudioField[] => {
  const needle = query.trim().toLowerCase();
  const matches = (field: StudioField): boolean => {
    if (needle === "") {
      return true;
    }
    const label = field.label === "" ? field.path : field.label;
    return (
      field.path.toLowerCase().includes(needle) ||
      label.toLowerCase().includes(needle)
    );
  };
  return fields.filter(matches).slice(0, SLASH_MENU_MAX_FIELDS);
};

/** Row count for the active view, so the key handler can wrap/clamp the
 *  highlight without rebuilding the clause list (clauses come from a query
 *  whose length the caller passes in). */
const slashRowCount = (
  view: SlashView,
  query: string,
  fields: StudioField[],
  clauseCount: number,
): number => {
  if (view === "fields") {
    return matchingSlashFields(query, fields).length;
  }
  if (view === "clauses") {
    return clauseCount;
  }
  return buildSlashRootItems(query, fields).length;
};

/** Session-lived answers for the selection popover, keyed by exact selection
 *  + surrounding context + the known-paths list; bounded FIFO so it cannot
 *  grow unchecked. */
const GESTURE_ENRICHMENT_CACHE_MAX = 100;
const gestureEnrichmentCache = new BoundedMap<string, GestureEnrichment>(
  GESTURE_ENRICHMENT_CACHE_MAX,
);

/** Progressive AI proposal for the popover's AI row. `fieldPath` carries the
 *  model's claim that the selection is another occurrence of an existing
 *  field; it is re-checked against the session's fields at render/accept
 *  time. */
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

/** Tiny stable digest (a polynomial rolling hash over the joined list) so
 *  the enrichment cache key reflects the known-paths list without storing
 *  it verbatim. */
const HASH_MODULUS = 2 ** 48;
const hashStrings = (values: readonly string[]): string => {
  let hash = 5381;
  for (const char of values.join("\u0000")) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % HASH_MODULUS;
  }
  return hash.toString(36);
};

/** The session's field paths as they ride along in the enrichment
 *  instruction: capped in count and joined length. */
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
      focusEditor: () => actionsRef.current?.focusEditor(),
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

  // A clause-slot name not already taken by another `{{@clause:...}}` marker
  // in the document, or claimed by a deferred slot rename: a pending step's
  // fromSlot is absent from the document but still on the server row (or
  // transiently claimed mid-replay), so linking a new clause under it would
  // collide with the per-template unique-slot constraint at PUT time.
  const uniqueClauseSlotName = (base: string): string => {
    const view = editorViewRef.current;
    const seed = base === "" ? "clause" : base;
    const taken = new Set([
      ...(view
        ? getTemplateDirectives(view.state).flatMap((d) =>
            d.kind === "clause" ? [d.expr] : [],
          )
        : []),
      ...useTemplateStudioStore
        .getState()
        .pendingSlotRenames.flatMap((step) => [step.fromSlot, step.slotName]),
    ]);
    let candidate = seed;
    for (let n = 2; taken.has(candidate); n++) {
      candidate = `${seed}_${n}`;
    }
    return candidate;
  };

  // Link a chosen library clause to the slot just inserted, reusing the same
  // template-clause link endpoint the clause inspector + link dialog use.
  const linkClauseToSlot = async (clauseId: string, slotName: string) => {
    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .clauses.put({ clauseId: toSafeId<"clause">(clauseId), slotName });
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.linkFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.templates.clauses(
        activeOrganizationId,
        templateId,
      ),
    });
  };

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
      // The popover is also capped at the host width (max-w: …,100%), so in a
      // pane narrower than its natural width the real half-width is host/2 —
      // clamp with that to keep it from spilling past the edge.
      const halfWidth = Math.min(
        GESTURE_POPOVER_HALF_WIDTH_PX,
        host.clientWidth / 2,
      );
      setGesture({
        ...sel,
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

  const fetchGestureSuggestion = async (sel: GestureSelection, seq: number) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const contextText = paragraphsAroundSelection(view.state, sel.from);
    const knownPaths = enrichmentKnownPaths(
      useTemplateStudioStore.getState().fields,
    );
    // Re-selecting the same text in the same context is common (the popover
    // dismisses on any click); serve the model's previous answer instead of
    // paying for it again. The known-paths list changes rarely; its hash
    // keys the existing-field part of the answer.
    const cacheKey = `${sel.text}\u0000${contextText}\u0000${hashStrings(knownPaths)}`;
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
        `The user selected this exact text: "${sel.text}". Propose exactly ` +
        `ONE field for that exact selection (literalText must equal it): ` +
        `its label and input type, plus an aiPrompt only when the selection ` +
        `is free-form prose that AI should draft at fill ` +
        `time.${existingFieldsClause}`,
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
      fieldPath: match.fieldPath,
    };
    gestureEnrichmentCache.set(cacheKey, ready);
    setEnrichment(ready);
  };

  const enrichGesture = useDebouncedCallback((sel: GestureSelection) => {
    const shown = gestureRef.current;
    if (shown === null || shown.from !== sel.from || shown.to !== sel.to) {
      return;
    }
    const seq = ++enrichSeqRef.current;
    fetchGestureSuggestion(sel, seq).catch((error: unknown) => {
      if (seq !== enrichSeqRef.current) {
        return;
      }
      getAnalytics().captureError(error);
      setEnrichment({ status: "idle" });
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    });
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

  const dismissGesture = () => {
    showGesture.cancel();
    enrichGesture.cancel();
    hideGesture();
  };

  /** The popover's "Existing field…" list: reuse a field over the captured
   *  selection. */
  const applyExistingFieldGesture = (path: string) => {
    const shown = gestureRef.current;
    if (shown === null) {
      return;
    }
    insertExistingFieldAt(path, {
      range: { from: shown.from, to: shown.to },
    });
    dismissGesture();
  };

  /** Wrap the captured selection in an existing condition (reuse), referencing
   *  it by name so the gate shares the condition-field's single source. */
  const applyExistingConditionGesture = (conditionName: string) => {
    const shown = gestureRef.current;
    if (shown === null) {
      return;
    }
    insertOrWrapBlock(
      `{{#if ${conditionName}}}`,
      "{{/if}}",
      conditionName,
      { from: shown.from, to: shown.to },
      true,
    );
    dismissGesture();
  };

  /** Accept the AI proposal row: when the model recognized the selection as
   *  another occurrence of an existing field, reuse that field; otherwise
   *  make a new field carrying the proposed configuration. */
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
            .fields.find((f) => f.path === enrichment.fieldPath);
    if (existing !== undefined) {
      insertExistingFieldAt(existing.path, { range });
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

  // Each button acts on the selection captured when the popover anchored, so
  // a click can never target a drifted live selection.
  const applyGesture = (kind: "field" | "if" | "each" | "clause") => {
    const shown = gestureRef.current;
    if (shown === null) {
      return;
    }
    const range = { from: shown.from, to: shown.to };
    if (kind === "field") {
      // The plain row is deliberately generic; the AI proposal accepts via
      // its own row below the separator.
      makeField(range);
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
    dismissGesture();
  };

  // Escape, any scroll, and the (custom) context menu all dismiss the
  // popover: the selection survives, only the floating affordance leaves.
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
      host?.removeEventListener("scroll", dismiss, {
        capture: true,
      });
      host?.removeEventListener("contextmenu", dismiss, { capture: true });
    };
  }, [gestureShown, hideGesture]);

  useExternalSyncEffect(
    () => () => {
      showGesture.cancel();
      enrichGesture.cancel();
    },
    [showGesture, enrichGesture],
  );

  // ── Slash-command menu ───────────────────────────────────
  // Typing `/` at a marker boundary opens a keyboard-first, command-palette-style
  // menu at the caret. The root lists two direct creators (New field, Condition)
  // and two submenu openers (Existing field, Clause); the typed text filters the
  // rows and doubles as a new field's name. Folio's plugin owns the trigger and
  // forwards navigation keys; this host renders the menu, tracks the highlighted
  // row + active submenu, and performs the insertion.
  const [slash, setSlashState] = useState<SlashMenu | null>(null);
  const [slashView, setSlashViewState] = useState<SlashView>("root");
  const [slashHighlight, setSlashHighlightState] = useState(0);
  // Mirrors for the plugin's synchronous key handler, which fires outside the
  // React render cycle and needs the freshest view + highlight + row count.
  const slashViewRef = useRef<SlashView>("root");
  const slashHighlightRef = useRef(0);
  // The `/` anchor the menu is currently positioned for; a change means a fresh
  // trigger that needs (re)positioning, vs. the same trigger's query growing.
  const slashFromRef = useRef<number | null>(null);
  const setSlashView = (view: SlashView) => {
    slashViewRef.current = view;
    setSlashViewState(view);
  };
  const setSlashHighlight = (index: number) => {
    slashHighlightRef.current = index;
    setSlashHighlightState(index);
  };
  const studioFields = useTemplateStudioStore((s) => s.fields);

  // Clause library for the clause submenu, searched by the live `/` query.
  // Enabled only while that submenu is open so the root menu costs nothing.
  const slashClausesEnabled = slash !== null && slashView === "clauses";
  // Debounced so search-as-you-type filters server-side without a query per
  // keystroke. The server does prefix full-text matching (scales with the
  // library); the client never holds the whole library.
  const [debouncedClauseSearch] = useDebounce(
    slashView === "clauses" ? (slash?.query ?? "") : "",
    120,
  );
  const { data: slashClauseData } = useQuery({
    ...clauseLibraryOptions(activeOrganizationId, {
      search: debouncedClauseSearch,
      limit: SLASH_MENU_CLAUSE_LIMIT,
    }),
    enabled: slashClausesEnabled,
  });
  const slashClauses: SlashClause[] = useMemo(
    () =>
      slashClauseData && "items" in slashClauseData
        ? slashClauseData.items
        : [],
    [slashClauseData],
  );
  // Effect-synced (not render-mirrored) so the synchronous key handler reads the
  // freshest clause list — and the search it was fetched for — without assigning
  // a ref during render.
  const slashClausesRef = useRef<SlashClause[]>(slashClauses);
  const debouncedClauseSearchRef = useRef(debouncedClauseSearch);
  useExternalSyncEffect(() => {
    slashClausesRef.current = slashClauses;
    debouncedClauseSearchRef.current = debouncedClauseSearch;
  }, [slashClauses, debouncedClauseSearch]);

  // The rows visible for the current view + query, as a discriminated union so
  // render and the key handler narrow without unsafe casts.
  const slashRows = useMemo((): SlashRows => {
    if (slash === null) {
      return { view: "root", items: [] };
    }
    if (slashView === "fields") {
      return {
        view: "fields",
        items: matchingSlashFields(slash.query, studioFields),
      };
    }
    if (slashView === "clauses") {
      return { view: "clauses", items: slashClauses };
    }
    return {
      view: "root",
      items: buildSlashRootItems(slash.query, studioFields),
    };
  }, [slash, slashView, studioFields, slashClauses]);

  // Re-anchor the menu at the caret. Geometry only: the query is updated
  // synchronously in `onSlashMenuChange`, decoupled from the caret rect, so
  // filtering never waits on (or is dropped by) the paged editor's async caret
  // repaint. Folio paints the caret a frame or two after the selection change,
  // so retry briefly until it exists, then merge left/top/placement into the
  // already-rendered menu without disturbing the live query.
  const positionSlashMenu = useCallback((from: number) => {
    const host = overlayHostRef.current;
    if (!host) {
      return;
    }
    let attempts = 0;
    const read = () => {
      const liveView = editorViewRef.current;
      const live = liveView ? getTemplateSlashMenu(liveView.state) : null;
      // Bail if the trigger is gone or has been replaced by a newer one (a
      // later keystroke re-anchored at a different `/`); the matching call will
      // position that one.
      if (
        liveView === null ||
        live === null ||
        !live.active ||
        live.from !== from
      ) {
        return;
      }
      const rect = getFolioCaretViewportRect(liveView);
      if (!rect) {
        attempts++;
        if (attempts < 10) {
          // eslint-disable-next-line react/react-compiler -- recursive local function flagged as its own dependency; `read` is not a reactive value and cannot be added to the useCallback deps
          requestAnimationFrame(read);
        }
        return;
      }
      const hostRect = host.getBoundingClientRect();
      const caretLeft = rect.left - hostRect.left;
      const caretTop = rect.top - hostRect.top;
      const caretBottom = rect.bottom - hostRect.top;
      // Prefer opening ABOVE the caret (below-placement collides with the
      // suggested-action chips and the floating AI bar pinned at the bottom),
      // but only when there is actually room above — otherwise the menu would
      // render off the top of the editor. Near the top, fall back to below.
      const fitsAbove =
        caretTop - SLASH_MENU_OFFSET_PX - SLASH_MENU_EST_HEIGHT_PX >= 0;
      const placement = fitsAbove ? "above" : "below";
      // Anchor the menu's start edge at the caret, clamping against the ACTUAL
      // rendered width so it never spills off the inline-end edge. Below the `sm`
      // breakpoint `MenuPreviewLayout` hides the preview pane, so the menu is just
      // the list column — clamping against the full desktop width there would
      // shove a near-caret menu needlessly to the left.
      const renderedWidth =
        window.innerWidth >= SLASH_MENU_PREVIEW_BREAKPOINT_PX
          ? SLASH_MENU_WIDTH_PX
          : SLASH_MENU_LIST_WIDTH_PX;
      const left = Math.max(
        0,
        Math.min(caretLeft, host.clientWidth - renderedWidth),
      );
      setSlashState((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              left,
              top: placement === "below" ? caretBottom : caretTop,
              placement,
            },
      );
    };
    requestAnimationFrame(read);
  }, []);

  const onSlashMenuChange = (state: TemplateSlashMenuState) => {
    if (!state.active) {
      setSlashState(null);
      setSlashView("root");
      slashFromRef.current = null;
      return;
    }
    // Update the query SYNCHRONOUSLY so the visible rows filter on every
    // keystroke. The menu is anchored at the `/` and does NOT follow the caret
    // as the query grows, so geometry is computed once on open; default
    // placement is "below" so a not-yet-positioned menu shows on-screen below
    // the caret rather than translating its height off the top of the editor.
    const isNewTrigger = slashFromRef.current !== state.from;
    slashFromRef.current = state.from;
    setSlashState((prev) => ({
      from: state.from,
      query: state.query,
      left: prev?.left ?? 0,
      top: prev?.top ?? 0,
      placement: prev?.placement ?? "below",
    }));
    // Reset the highlight to the top row whenever the query changes; the row
    // list is rebuilt and the previous index may point at a gone row.
    setSlashHighlight(0);
    // Position only when the trigger first anchors at a new `/`: the menu stays
    // pinned to the `/` as the query grows, and re-reading the caret rect per
    // keystroke both churns and races the paged-editor relayout.
    if (isNewTrigger) {
      positionSlashMenu(state.from);
    }
  };

  const dismissSlash = useCallback(() => {
    const view = editorViewRef.current;
    if (view && getTemplateSlashMenu(view.state).active) {
      view.dispatch(clearTemplateSlashMenu(view.state.tr));
    }
    setSlashState(null);
    // eslint-disable-next-line react/react-compiler -- `setSlashView` closes only over the stable setSlashViewState setter and slashViewRef, so a stale closure is a no-op; empty deps are intentional to keep dismissSlash referentially stable for the [slashShown, dismissSlash] effect below
    setSlashView("root");
    slashFromRef.current = null;
  }, []);

  // Insert a fresh field marker, selecting the name so syncSelection opens the
  // field face. Reuses `from` from the consumed `/query` range.
  const slashInsertNewField = (
    view: EditorView,
    consumed: { tr: Transaction; from: number },
    path: string,
  ) => {
    const tr = consumed.tr.insertText(`{{${path}}}`, consumed.from);
    const namePos = consumed.from + 2;
    tr.setSelection(
      TextSelection.create(tr.doc, namePos, namePos + path.length),
    ).scrollIntoView();
    view.dispatch(tr);
    view.focus();
    upsertField(path, {});
    markDirty();
  };

  // Switch menu level. Reset the typed `/` query to blank so each level filters
  // from scratch (the submenu's search is its own; the root's is its own).
  const enterSlashSubmenu = (next: SlashView) => {
    const editor = editorViewRef.current;
    if (editor) {
      const tr = resetTemplateSlashQuery(editor.state);
      if (tr !== null) {
        editor.dispatch(tr);
      }
    }
    setSlashView(next);
    setSlashHighlight(0);
  };

  // Activate a root row: direct creators insert immediately; submenu openers
  // switch the view instead.
  const activateSlashRoot = (item: SlashRootItem) => {
    if (item.kind === "open-fields") {
      enterSlashSubmenu("fields");
      return;
    }
    if (item.kind === "open-clauses") {
      enterSlashSubmenu("clauses");
      return;
    }
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const consumed = consumeTemplateSlashQuery(view.state);
    if (consumed === null) {
      return;
    }
    if (item.kind === "create-field") {
      slashInsertNewField(view, consumed, item.path);
      dismissSlash();
      return;
    }
    if (item.kind === "field") {
      // Reuse an existing field picked inline from the filtered root list.
      view.dispatch(
        consumed.tr
          .insertText(`{{${item.path}}}`, consumed.from)
          .scrollIntoView(),
      );
      view.focus();
      markDirty();
      dismissSlash();
      return;
    }
    // create-condition: drop the query, then insert the block at the collapsed
    // caret via the shared block helper.
    view.dispatch(consumed.tr.scrollIntoView());
    insertCondition();
    dismissSlash();
  };

  // Reuse a registered field at the caret without forcing focus there.
  const activateSlashField = (path: string) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const consumed = consumeTemplateSlashQuery(view.state);
    if (consumed === null) {
      return;
    }
    view.dispatch(
      consumed.tr.insertText(`{{${path}}}`, consumed.from).scrollIntoView(),
    );
    view.focus();
    markDirty();
    dismissSlash();
  };

  // Insert a clause slot named after the chosen clause and link that slot to it,
  // reusing the same slot + link mechanism as the clause inspector.
  const activateSlashClause = (clause: { id: string; title: string }) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    // Both the Enter and click paths land here. Don't insert a stale clause: if
    // the 120ms-debounced clause search has not caught up to the live query, the
    // visible rows are from the previous query — bail until they refresh.
    const live = getTemplateSlashMenu(view.state);
    if (live.active && debouncedClauseSearchRef.current !== live.query) {
      return;
    }
    const consumed = consumeTemplateSlashQuery(view.state);
    if (consumed === null) {
      return;
    }
    const slotName = uniqueClauseSlotName(slugify(clause.title));
    view.dispatch(
      consumed.tr
        .insertText(`{{@clause:${slotName}}}`, consumed.from)
        .scrollIntoView(),
    );
    view.focus();
    markDirty();
    dismissSlash();
    void linkClauseToSlot(clause.id, slotName);
  };

  const onSlashMenuKeyAction = (
    action: TemplateSlashMenuKeyAction,
  ): boolean => {
    // Derive everything fresh from the live trigger + current view so the
    // synchronous key handler never acts on a stale render.
    const view = editorViewRef.current;
    const live = view ? getTemplateSlashMenu(view.state) : null;
    if (live === null || !live.active) {
      return false;
    }
    const currentView = slashViewRef.current;
    if (action === "back") {
      if (currentView === "root") {
        return false;
      }
      enterSlashSubmenu("root");
      return true;
    }
    if (action === "dismiss") {
      if (currentView === "root") {
        return false;
      }
      enterSlashSubmenu("root");
      return true;
    }
    const rowCount = slashRowCount(
      currentView,
      live.query,
      useTemplateStudioStore.getState().fields,
      slashClausesRef.current.length,
    );
    if (rowCount === 0) {
      // Keep arrows/enter swallowed so a momentarily empty submenu does not move
      // the document caret out from under the open menu.
      return action === "up" || action === "down" || action === "commit";
    }
    if (action === "up") {
      setSlashHighlight((slashHighlightRef.current - 1 + rowCount) % rowCount);
      return true;
    }
    if (action === "down") {
      setSlashHighlight((slashHighlightRef.current + 1) % rowCount);
      return true;
    }
    const index = Math.min(slashHighlightRef.current, rowCount - 1);
    if (currentView === "root") {
      const items = buildSlashRootItems(
        live.query,
        useTemplateStudioStore.getState().fields,
      );
      const item = items.at(index);
      if (item === undefined) {
        return false;
      }
      // ArrowRight only enters submenu openers; on a creator row it is a no-op.
      if (action === "forward") {
        if (item.kind === "open-fields" || item.kind === "open-clauses") {
          activateSlashRoot(item);
          return true;
        }
        return false;
      }
      activateSlashRoot(item);
      return true;
    }
    // forward inside a submenu has no deeper level.
    if (action === "forward") {
      return false;
    }
    if (currentView === "fields") {
      const field = matchingSlashFields(
        live.query,
        useTemplateStudioStore.getState().fields,
      ).at(index);
      if (field === undefined) {
        return false;
      }
      activateSlashField(field.path);
      return true;
    }
    // Enter on a clause: `activateSlashClause` bails if the debounced search is
    // stale, so a too-fast Enter waits for refreshed rows instead of inserting
    // the wrong clause. Swallow the key either way so it never adds a newline.
    const clause = slashClausesRef.current.at(index);
    if (clause === undefined) {
      return false;
    }
    activateSlashClause(clause);
    return true;
  };

  // A USER scroll of the document (wheel/touch) — or a context action — tears the
  // menu down, since it is anchored to the `/` and would otherwise float. We
  // listen for wheel/touchmove, NOT the generic `scroll` event: typing near the
  // bottom programmatically scrolls the editor to keep the caret in view, and
  // that must not close the menu mid-filter. Scrolling within the menu's own list
  // is excluded so the user can scroll a long result set.
  const slashShown = slash !== null;
  useExternalSyncEffect(() => {
    if (!slashShown) {
      return undefined;
    }
    const host = overlayHostRef.current;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[role="listbox"]')
      ) {
        return;
      }
      dismissSlash();
    };
    host?.addEventListener("wheel", dismiss, { capture: true, passive: true });
    host?.addEventListener("touchmove", dismiss, {
      capture: true,
      passive: true,
    });
    host?.addEventListener("contextmenu", dismiss, { capture: true });
    return () => {
      host?.removeEventListener("wheel", dismiss, { capture: true });
      host?.removeEventListener("touchmove", dismiss, { capture: true });
      host?.removeEventListener("contextmenu", dismiss, { capture: true });
    };
  }, [slashShown, dismissSlash]);

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
    focusEditor: () => editorViewRef.current?.focus(),
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
              onSelectionTextChange={onGestureSelectionChange}
              onSlashMenuChange={onSlashMenuChange}
              onSlashMenuKeyAction={onSlashMenuKeyAction}
              showTemplateDirectives={showDirectives}
            />
          </Suspense>
        </div>
        {slash !== null && (
          <SlashMenuPopover
            slash={slash}
            rows={slashRows}
            highlight={slashHighlight}
            fields={studioFields}
            onHighlight={setSlashHighlight}
            onActivateRoot={activateSlashRoot}
            onActivateField={activateSlashField}
            onActivateClause={activateSlashClause}
            onBack={() => enterSlashSubmenu("root")}
          />
        )}
        {gesture !== null && (
          <SelectionGesturePopover
            enrichment={enrichment}
            gesture={gesture}
            onAcceptAi={applyAiGesture}
            onInsertExisting={applyExistingFieldGesture}
            onMakeClause={() => applyGesture("clause")}
            onMakeField={() => applyGesture("field")}
            onWrapEach={() => applyGesture("each")}
            onWrapIf={() => applyGesture("if")}
            onWrapIfExisting={applyExistingConditionGesture}
          />
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
/** The selection's containing paragraph plus one paragraph on each side —
 *  enough context for the model to read how a new field is used, read from
 *  the live doc because the field marker does not exist yet. */
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
 *  Instant rows first (plain Make field, the existing-field list, the
 *  structural wraps); the AI proposal lands as its own row below a
 *  separator once the model answers. */
const SelectionGesturePopover = ({
  gesture,
  enrichment,
  onMakeField,
  onInsertExisting,
  onAcceptAi,
  onWrapIf,
  onWrapIfExisting,
  onWrapEach,
  onMakeClause,
}: {
  gesture: SelectionGesture;
  enrichment: GestureEnrichment;
  onMakeField: () => void;
  onInsertExisting: (path: string) => void;
  onAcceptAi: () => void;
  onWrapIf: () => void;
  onWrapIfExisting: (name: string) => void;
  onWrapEach: () => void;
  onMakeClause: () => void;
}) => {
  const t = useTranslations();
  const fields = useTemplateStudioStore((s) => s.fields);
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

/** A row's icon + translated label + optional right-aligned marker hint. */
type SlashRowFace = {
  icon: LucideIcon;
  label: string;
  /** Right-aligned hint: the marker the row inserts, or a field's path. */
  hint: string | undefined;
};

/** Root rows tagged with a section so the menu can render Notion-style grouped
 *  dividers while keeping one flat, query-filtered, keyboard-navigable order. */
const SLASH_ROOT_GROUP = {
  "create-field": "primary",
  "create-condition": "primary",
  field: "reuse",
  "open-fields": "reuse",
  "open-clauses": "reuse",
} as const satisfies Record<SlashRootItem["kind"], "primary" | "reuse">;

const SLASH_GROUP_LABEL = {
  primary: "templates.studio.slashGroupInsert",
  reuse: "templates.studio.slashGroupReuse",
} as const satisfies Record<"primary" | "reuse", TranslationKey>;

/** Keyboard-first, command-palette-style menu anchored at the caret, opened by
 *  typing `/` in template prose. The highlighted row tracks the slash plugin's
 *  Up/Down/Left/Right/Enter; clicks use `keepEditorFocus` so the painted caret
 *  stays put while inserting. Three views: a grouped root of creators + submenu
 *  openers, an existing-field reuse list, and a searchable clause library. The
 *  highlighted row's description flies out beside the menu via the shared
 *  preview-pane layout. A pinned footer carries the Escape hint. */
const SlashMenuPopover = ({
  slash,
  rows,
  highlight,
  fields,
  onHighlight,
  onActivateRoot,
  onActivateField,
  onActivateClause,
  onBack,
}: {
  slash: SlashMenu;
  rows: SlashRows;
  highlight: number;
  fields: StudioField[];
  onHighlight: (index: number) => void;
  onActivateRoot: (item: SlashRootItem) => void;
  onActivateField: (path: string) => void;
  onActivateClause: (clause: SlashClause) => void;
  onBack: () => void;
}) => {
  const t = useTranslations();
  const empty =
    rows.view === "clauses"
      ? t("clauses.noResults")
      : t("templates.studio.slashEmpty");
  return (
    <div
      className="bg-popover text-popover-foreground absolute z-50 flex flex-col rounded-md border text-sm shadow-lg/5 transition-opacity duration-100 starting:opacity-0"
      role="listbox"
      style={{
        left: slash.left,
        top: slash.top,
        transform:
          slash.placement === "above"
            ? `translate(0, calc(-100% - ${SLASH_MENU_OFFSET_PX}px))`
            : `translate(0, ${SLASH_MENU_OFFSET_PX}px)`,
      }}
    >
      <SlashMenuHeader query={slash.query} view={rows.view} onBack={onBack} />
      <MenuPreviewLayout
        className="min-h-0"
        preview={
          <PreviewPane>
            <SlashPreview fields={fields} highlight={highlight} rows={rows} />
          </PreviewPane>
        }
      >
        <div className="max-h-[min(18rem,60vh)] min-h-0 w-56 overflow-y-auto p-1">
          {rows.items.length === 0 && (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">{empty}</p>
          )}
          <SlashMenuRows
            fields={fields}
            highlight={highlight}
            rows={rows}
            onActivateClause={onActivateClause}
            onActivateField={onActivateField}
            onActivateRoot={onActivateRoot}
            onHighlight={onHighlight}
          />
        </div>
      </MenuPreviewLayout>
      <div className="text-muted-foreground border-t px-3 py-1 text-[11px] leading-snug">
        {t("templates.studio.slashFooter")}
      </div>
    </div>
  );
};

/** Compact header: the breadcrumb/back affordance for a submenu, or the typed
 *  query / typing hint at the root. */
const SlashMenuHeader = ({
  view,
  query,
  onBack,
}: {
  view: SlashView;
  query: string;
  onBack: () => void;
}) => {
  const t = useTranslations();
  if (view === "root") {
    return (
      <p className="text-muted-foreground truncate border-b px-3 py-1.5 text-[11px] leading-snug">
        {query === "" ? t("templates.studio.slashHint") : `/${query}`}
      </p>
    );
  }
  const label =
    view === "fields"
      ? t("templates.studio.existingField")
      : t("common.clauses");
  return (
    <button
      className="text-muted-foreground hover:text-foreground flex items-center gap-1 border-b px-3 py-1.5 text-start text-[11px] leading-snug"
      onClick={onBack}
      onMouseDown={keepEditorFocus}
      type="button"
    >
      <DirectionalIcon className="size-3 shrink-0" icon={ChevronLeftIcon} />
      <span className="truncate">
        {label}
        {query === "" ? "" : ` · ${query}`}
      </span>
    </button>
  );
};

const SlashMenuRows = ({
  rows,
  highlight,
  fields,
  onHighlight,
  onActivateRoot,
  onActivateField,
  onActivateClause,
}: {
  rows: SlashRows;
  highlight: number;
  fields: StudioField[];
  onHighlight: (index: number) => void;
  onActivateRoot: (item: SlashRootItem) => void;
  onActivateField: (path: string) => void;
  onActivateClause: (clause: SlashClause) => void;
}) => {
  if (rows.view === "root") {
    return (
      <SlashRootRows
        highlight={highlight}
        rows={rows.items}
        onActivateRoot={onActivateRoot}
        onHighlight={onHighlight}
      />
    );
  }
  if (rows.view === "fields") {
    return (
      <>
        {rows.items.map((field, index) => (
          <SlashMenuRow
            key={field.path}
            face={slashFieldFace(field, fields)}
            selected={index === highlight}
            onHighlight={() => onHighlight(index)}
            onSelect={() => onActivateField(field.path)}
          />
        ))}
      </>
    );
  }
  return (
    <>
      {rows.items.map((clause, index) => (
        <SlashMenuRow
          key={clause.id}
          face={{ icon: TextQuoteIcon, label: clause.title, hint: undefined }}
          selected={index === highlight}
          onHighlight={() => onHighlight(index)}
          onSelect={() => onActivateClause(clause)}
        />
      ))}
    </>
  );
};

/** Root rows, split into Notion-style grouped sections with quiet labels while
 *  keeping the flat highlight index aligned with the key handler's order. */
const SlashRootRows = ({
  rows,
  highlight,
  onHighlight,
  onActivateRoot,
}: {
  rows: SlashRootItem[];
  highlight: number;
  onHighlight: (index: number) => void;
  onActivateRoot: (item: SlashRootItem) => void;
}) => {
  const t = useTranslations();
  return (
    <>
      {rows.map((item, index) => {
        const prev = rows.at(index - 1);
        const group = SLASH_ROOT_GROUP[item.kind];
        const showLabel =
          index === 0 ||
          prev === undefined ||
          SLASH_ROOT_GROUP[prev.kind] !== group;
        // Field rows carry a dynamic label (the field name), so resolve their
        // face inline; the fixed entry rows resolve a translation key.
        let face: SlashRowFace;
        if (item.kind === "field") {
          face = {
            icon: BracesIcon,
            label: item.label,
            hint: item.label === item.path ? undefined : item.path,
          };
        } else {
          const rootFace = slashRootFace(item);
          face = {
            icon: rootFace.icon,
            label: t(rootFace.labelKey),
            hint: rootFace.hint,
          };
        }
        return (
          <div key={slashRootKey(item)}>
            {showLabel && (
              <p className="text-muted-foreground px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide uppercase">
                {t(SLASH_GROUP_LABEL[group])}
              </p>
            )}
            <SlashMenuRow
              chevron={
                item.kind === "open-fields" || item.kind === "open-clauses"
              }
              face={face}
              selected={index === highlight}
              onHighlight={() => onHighlight(index)}
              onSelect={() => onActivateRoot(item)}
            />
          </div>
        );
      })}
    </>
  );
};

const SlashMenuRow = ({
  face,
  selected,
  chevron = false,
  onHighlight,
  onSelect,
}: {
  face: SlashRowFace;
  selected: boolean;
  chevron?: boolean;
  onHighlight: () => void;
  onSelect: () => void;
}) => {
  const { icon: Icon, label, hint } = face;
  const rowRef = useRef<HTMLButtonElement | null>(null);
  // Keep the keyboard-highlighted row in view when the list overflows.
  useExternalSyncEffect(() => {
    if (selected) {
      rowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);
  return (
    <button
      aria-selected={selected}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-start",
        selected ? "bg-accent text-accent-foreground" : "text-foreground",
      )}
      // eslint-disable-next-line react/react-compiler -- containedHandler defers the rowRef.current read into the returned click handler; the ref is not read during render
      onClick={containedHandler(rowRef, onSelect)}
      // eslint-disable-next-line react/react-compiler -- containedHandler defers the rowRef.current read into the returned mousedown handler; the ref is not read during render
      onMouseDown={containedHandler(rowRef, (event: ReactMouseEvent) =>
        event.preventDefault(),
      )}
      onMouseEnter={onHighlight}
      ref={rowRef}
      role="option"
      tabIndex={-1}
      type="button"
    >
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="flex-1 truncate" dir="auto">
        {label}
      </span>
      {hint !== undefined && (
        <span className="text-muted-foreground shrink-0 truncate font-mono text-[10px]">
          {hint}
        </span>
      )}
      {chevron && (
        <DirectionalIcon
          className="text-muted-foreground size-3.5 shrink-0"
          icon={ChevronRightIcon}
        />
      )}
    </button>
  );
};

/** The flyout description for the highlighted row, shown in the preview pane. */
const SlashPreview = ({
  rows,
  highlight,
  fields,
}: {
  rows: SlashRows;
  highlight: number;
  fields: StudioField[];
}) => {
  const t = useTranslations();
  if (rows.view === "clauses") {
    const clause = rows.items.at(highlight);
    if (clause === undefined) {
      return <SlashPreviewEmpty />;
    }
    return <SlashClausePreview clause={clause} />;
  }
  if (rows.view === "fields") {
    const field = rows.items.at(highlight);
    if (field === undefined) {
      return <SlashPreviewEmpty />;
    }
    return (
      <SlashTextPreview
        marker={`{{${field.path}}}`}
        title={slashFieldFace(field, fields).label}
        body={t("templates.studio.conceptField")}
      />
    );
  }
  const item = rows.items.at(highlight);
  if (item === undefined) {
    return <SlashPreviewEmpty />;
  }
  return <SlashRootPreview item={item} />;
};

const SlashPreviewEmpty = () => {
  const t = useTranslations();
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center text-center text-xs text-balance">
      {t("templates.studio.previewHint")}
    </div>
  );
};

const SlashRootPreview = ({ item }: { item: SlashRootItem }) => {
  const t = useTranslations();
  if (item.kind === "create-field") {
    return (
      <SlashTextPreview
        marker={`{{${item.path}}}`}
        title={t("templates.studio.makeField")}
        body={t("templates.studio.conceptField")}
      />
    );
  }
  if (item.kind === "create-condition") {
    return (
      <SlashTextPreview
        marker="{{#if …}} … {{/if}}"
        title={t("templates.studio.showOnlyIf")}
        body={t("templates.studio.conceptCondition")}
      />
    );
  }
  if (item.kind === "open-fields") {
    return (
      <SlashTextPreview
        marker="{{ … }}"
        title={t("templates.studio.existingField")}
        body={t("templates.studio.conceptField")}
      />
    );
  }
  return (
    <SlashTextPreview
      marker="{{@clause: … }}"
      title={t("common.clauses")}
      body={t("templates.studio.conceptClause")}
    />
  );
};

const SlashTextPreview = ({
  marker,
  title,
  body,
}: {
  marker: string;
  title: string;
  body: string;
}) => (
  <div className="flex h-full flex-col gap-1.5 overflow-hidden text-xs">
    <code className="bg-primary/10 text-primary w-fit rounded px-1 py-0.5 text-[10px]">
      {marker}
    </code>
    <p className="text-foreground font-medium">{title}</p>
    <p className="text-muted-foreground leading-snug">{body}</p>
  </div>
);

const SlashClausePreview = ({ clause }: { clause: SlashClause }) => {
  const t = useTranslations();
  const description = clause.description?.trim();
  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden text-xs">
      <p className="text-foreground font-medium" dir="auto">
        {clause.title}
      </p>
      <p className="text-muted-foreground">
        {t("common.versionLabel", { version: String(clause.currentVersion) })}
      </p>
      <p className="text-muted-foreground leading-snug" dir="auto">
        {description && description.length > 0
          ? description
          : t("templates.studio.conceptClause")}
      </p>
    </div>
  );
};

/** Stable React key for a root row. */
const slashRootKey = (item: SlashRootItem): string => {
  if (item.kind === "create-field") {
    return `create-field:${item.path}`;
  }
  if (item.kind === "field") {
    return `field:${item.path}`;
  }
  return item.kind;
};

/** The four root-row labels, none of which take ICU arguments, so the caller's
 *  `t(labelKey)` needs no values arg (typing this as the broad `TranslationKey`
 *  would force one). */
type SlashRootLabelKey =
  | "templates.studio.makeField"
  | "templates.studio.showOnlyIf"
  | "templates.studio.existingField"
  | "common.clauses";

type SlashRootFace = {
  icon: LucideIcon;
  labelKey: SlashRootLabelKey;
  hint: string | undefined;
};

/** Icon + label-key + marker hint for a root row, mirroring the gesture-menu
 *  vocabulary. Returns the key (not the resolved string) so the caller's `t`
 *  does the lookup; passing `t` itself around explodes the message-key union. */
const slashRootFace = (item: SlashRootItem): SlashRootFace => {
  if (item.kind === "create-field") {
    return {
      icon: BracesIcon,
      labelKey: "templates.studio.makeField",
      hint: "{{ }}",
    };
  }
  if (item.kind === "create-condition") {
    return {
      icon: SplitIcon,
      labelKey: "templates.studio.showOnlyIf",
      hint: "{{#if}}",
    };
  }
  if (item.kind === "open-fields") {
    return {
      icon: BracesIcon,
      labelKey: "templates.studio.existingField",
      hint: undefined,
    };
  }
  return {
    icon: TextQuoteIcon,
    labelKey: "common.clauses",
    hint: undefined,
  };
};

const slashFieldFace = (
  field: StudioField,
  fields: StudioField[],
): SlashRowFace => {
  const match = fields.find((f) => f.path === field.path);
  const icon = match
    ? VALUE_TYPE_META[inputTypeValueKind(match.inputType)].icon
    : BracesIcon;
  const label = field.label === "" ? field.path : field.label;
  return {
    icon,
    label,
    hint: label === field.path ? undefined : field.path,
  };
};

/** What each gesture-menu insert produces, shown in the preview pane while a
 *  row is highlighted. Mock depictions of inserted document content, not
 *  interface text; deliberately untranslated to keep them free of per-language
 *  i18n debt. */
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
