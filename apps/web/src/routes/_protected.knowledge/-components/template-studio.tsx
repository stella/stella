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
  BracesIcon,
  EyeIcon,
  Loader2Icon,
  EyeOffIcon,
  PlusIcon,
  RepeatIcon,
  SaveIcon,
  SplitIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import { buildPositionalText, getTemplateDirectives } from "@stll/folio";
import type { DirectiveRange, DocxEditorRef } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
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
import { TemplateStudioAIBar } from "@/routes/_protected.knowledge/-components/template-ai-bar";
import { TemplateClausesTab } from "@/routes/_protected.knowledge/-components/template-clauses-tab";
import { TemplateForm } from "@/routes/_protected.knowledge/-components/template-form";
import { useTemplateNavStore } from "@/routes/_protected.knowledge/-components/template-nav-store";
import {
  defaultStudioField,
  type NameExpr,
  type StudioActions,
  type StudioField,
  useTemplateStudioStore,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import { TemplateVersionsTab } from "@/routes/_protected.knowledge/-components/template-versions-tab";
import {
  type EditableField,
  FieldConfigEditor,
} from "@/routes/_protected.knowledge/-components/template-wizard";
import {
  knowledgeKeys,
  templateClausesOptions,
  templateDetailOptions,
  templateDocxBufferOptions,
} from "@/routes/_protected.knowledge/-queries";

const DocxEditor = lazy(async () => {
  const m = await import("@stll/folio");
  return { default: m.DocxEditor };
});

const protectedRouteApi = getRouteApi("/_protected");

const TEMPLATE_STUDIO_VIEW = "template-studio";
const MAKE_FIELD_CONTEXT_ID = "make-field";
const TEMPLATES_ROUTE_ID = "/_protected/knowledge/templates";
const templateStudioTabId = (templateId: string) =>
  `template-studio:${templateId}`;

type TemplateStudioPayload = { templateId: string };

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
  // Reactive twin of editorViewRef for children that re-render on view
  // creation (the floating AI bar needs a live prop, not a ref).
  const [liveEditorView, setLiveEditorView] = useState<EditorView | null>(null);
  // useFitToWidth's containerRef is a callback ref, so capture the node in
  // state too — the AI bar wants the element itself.
  const [containerNode, setContainerNode] = useState<HTMLElement | null>(null);
  const attachContainer = useCallback(
    (node: HTMLElement | null) => {
      setContainerNode(node);
      return containerRef(node);
    },
    [containerRef],
  );
  // Right-click on selected text offers turning it into a {{field}} directly.
  const makeFieldContextItems = useMemo(
    () => [
      {
        id: MAKE_FIELD_CONTEXT_ID,
        label: t("templates.studio.makeField"),
        requiresSelection: true,
        icon: <BracesIcon size={14} />,
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
      conditions: parseNameExprs(manifest, "conditions"),
      computed: parseNameExprs(manifest, "computed"),
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

  // Map the editor's caret to the directive it sits in, so the inspector tab
  // knows which face to show. Reads the live plugin state via the captured view.
  const syncSelection = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) {
      setSelected(null);
      return;
    }
    const head = view.state.selection.from;
    const covering = getTemplateDirectives(view.state).find(
      (range) => head >= range.from && head <= range.to,
    );
    setSelected(covering ?? null);
  }, [setSelected]);

  // The hero gesture: turn the current text selection into a `{{field}}`,
  // deriving a unique field path from the selected text and registering it in
  // the session (the dispatched selection change re-runs syncSelection).
  const makeField = (range?: { from: number; to: number }) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const { from, to } = range ?? view.state.selection;
    if (from === to) {
      return;
    }
    const text = view.state.doc.textBetween(from, to, " ");
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
      view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
      view.focus();
      markDirty();
    });

  // Block directives must occupy their own paragraph (the fill engine anchors
  // them line-by-line), so insert opener/body/closer as three paragraphs after
  // the current one.
  const insertBlock = (open: string, close: string) =>
    withEditorView((view) => {
      const { state } = view;
      const paragraph = state.schema.nodes["paragraph"];
      if (!paragraph) {
        return;
      }
      const para = (text: string) =>
        paragraph.create(
          null,
          text.length > 0 ? state.schema.text(text) : null,
        );
      const { $from } = state.selection;
      const pos = $from.depth >= 1 ? $from.after(1) : state.doc.content.size;
      try {
        view.dispatch(
          state.tr
            .insert(pos, [para(open), para(""), para(close)])
            .scrollIntoView(),
        );
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

  const insertCondition = () => insertBlock("{{#if condition}}", "{{/if}}");
  const insertLoop = () => insertBlock("{{#each items}}", "{{/each}}");
  const insertClause = () => insertInline("{{@clause:Clause}}");

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
      const { fields, conditions, computed } =
        useTemplateStudioStore.getState();
      const stored = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .document.post({
          file,
          manifest: JSON.stringify(
            buildManifest(manifest, fields, conditions, computed),
          ),
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
    insertField,
    insertCondition,
    insertLoop,
    insertClause,
    insertClauseSlot: (slotName) => insertInline(`{{@clause:${slotName}}}`),
    makeField,
    save: () => void handleSave(),
    suggestFieldConfig: async (path) => {
      const view = editorViewRef.current;
      if (!view) {
        return null;
      }
      const text = buildPositionalText(view.state.doc).text;
      const response = await api.templates["suggest-fields"].post({
        text,
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
      {/* `relative` so the floating AI bar + stepper anchor over the doc. */}
      <div className="relative min-h-0 flex-1">
        <div
          className="h-full [scrollbar-gutter:stable] overflow-auto"
          ref={attachContainer}
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
                }
              }}
              onCustomContextAction={(id, range) => {
                if (id === MAKE_FIELD_CONTEXT_ID) {
                  makeField(range);
                }
              }}
              customContextMenuItems={makeFieldContextItems}
              onSelectionChange={(state) => {
                setHasSelection(state?.hasSelection ?? false);
                syncSelection();
              }}
              showTemplateDirectives={showDirectives}
            />
          </Suspense>
        </div>
        <TemplateStudioAIBar
          containerEl={containerNode}
          editorView={liveEditorView}
          ensureView={forceEditorView}
          getView={getEditorView}
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
  const computed = useTemplateStudioStore((s) => s.computed);
  const selected = useTemplateStudioStore((s) => s.selected);
  const upsertField = useTemplateStudioStore((s) => s.upsertField);
  const setConditions = useTemplateStudioStore((s) => s.setConditions);
  const setComputed = useTemplateStudioStore((s) => s.setComputed);

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
      <StudioActionRow />
      <FacetBar
        facet={facet}
        facets={STUDIO_FACETS}
        labels={facetLabels}
        onChange={setFacet}
      />
      {!ready && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
        </div>
      )}
      {ready && facet === "fields" && (
        <Inspector
          conditions={conditions}
          computed={computed}
          fields={fields}
          onComputedChange={setComputed}
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
    </div>
  );
}

// Filling happens in-place as the "Fill" subtab. It targets the *saved*
// template (the fill endpoint reads from S3). The persisted manifest carries no
// field kind/itemFields, so re-discover the stored DOCX (the same merge the
// fill endpoint uses) to get the real field shape — {{#each}} array fields
// included — rather than reconstructing it from the flat manifest.
const TemplateFillFacet = ({ templateId }: { templateId: string }) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const detailOptions = templateDetailOptions(activeOrganizationId, templateId);
  const { data: detailData } = useQuery(detailOptions);
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
    <TemplateForm
      conditions={discovered.conditions}
      fields={discovered.fields}
      fileName={detail.fileName}
      onBack={() => undefined}
      onDone={() => undefined}
      structureErrors={discovered.structureErrors}
      templateId={templateId}
    />
  );
};

/** Document actions row — rendered in the inspector tab's top area; the page
 *  registers the handlers + UI state in the session store. */
const StudioActionRow = () => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const ui = useTemplateStudioStore((s) => s.ui);
  const isDirty = useTemplateStudioStore((s) => s.isDirty);
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
        "flex shrink-0 items-center gap-1 border-b px-3",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {ui.metaLabel}
      </span>
      <Button
        aria-label={t("common.preview")}
        onClick={actions.toggleDirectives}
        size="icon-sm"
        variant="ghost"
      >
        {ui.showDirectives ? <EyeIcon /> : <EyeOffIcon />}
      </Button>
      <Menu>
        <MenuTrigger
          aria-label={t("templates.studio.insert")}
          render={<Button size="icon-sm" variant="ghost" />}
        >
          <PlusIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={actions.insertField}>
            <BracesIcon />
            {t("templates.studio.scopeField")}
          </MenuItem>
          <MenuItem onClick={actions.insertCondition}>
            <SplitIcon />
            {t("templates.studio.scopeCondition")}
          </MenuItem>
          <MenuItem onClick={actions.insertLoop}>
            <RepeatIcon />
            {t("templates.studio.loop")}
          </MenuItem>
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
      <Button
        aria-label={t("templates.studio.makeField")}
        disabled={!ui.hasSelection}
        onClick={actions.makeField}
        size="icon-sm"
        variant="ghost"
      >
        <BracesIcon />
      </Button>
      <Button
        disabled={!isDirty || ui.isSaving}
        onClick={actions.save}
        size="sm"
      >
        <SaveIcon />
        {t("common.save")}
      </Button>
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
  conditions: NameExpr[];
  computed: NameExpr[];
  onFieldUpdate: (path: string, patch: Partial<StudioField>) => void;
  onConditionsChange: (next: NameExpr[]) => void;
  onComputedChange: (next: NameExpr[]) => void;
};

const Inspector = ({
  selected,
  fields,
  conditions,
  computed,
  onFieldUpdate,
  onConditionsChange,
  onComputedChange,
}: InspectorProps) => {
  const t = useTranslations();
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
    return (
      <ScrollArea className="min-h-0 flex-1">
        <ScopeHeader
          subtitle={selected.kind}
          title={t("templates.studio.scopeCondition")}
        />
        <div className="px-4 py-4">
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("templates.studio.conditionBlockHelp")}
          </p>
          <code className="bg-muted mt-2 block rounded px-3 py-2 text-xs">
            {selected.expr || "—"}
          </code>
          <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
            {t("templates.studio.namedConditionsHelp")}
          </p>
        </div>
      </ScrollArea>
    );
  }

  if (selected && selected.kind === "clause") {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <ScopeHeader
          subtitle={selected.expr}
          title={t("templates.studio.scopeClause")}
        />
        <div className="text-muted-foreground px-4 py-4 text-xs leading-relaxed">
          {t("templates.studio.clauseSlotHelp")}
        </div>
      </ScrollArea>
    );
  }

  // Default: whole-template settings.
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ScopeHeader title={t("templates.studio.scopeTemplate")} />
      <NameExprList
        addLabel={t("templates.addCondition")}
        emptyLabel={t("templates.studio.noConditions")}
        heading={t("templates.conditionsTitle")}
        items={conditions}
        onChange={onConditionsChange}
      />
      <Separator />
      <NameExprList
        addLabel={t("templates.studio.addComputedField")}
        emptyLabel={t("templates.studio.noComputed")}
        heading={t("templates.studio.computed")}
        items={computed}
        onChange={onComputedChange}
      />
      <Separator />
      <div className="px-4 py-4">
        <h3 className="text-muted-foreground mb-2 text-xs font-medium">
          {t("templates.fieldCount", { count: fields.length })}
        </h3>
        <ul className="flex flex-col gap-1">
          {fields.map((f) => (
            <li
              key={f.path}
              className="flex items-center justify-between text-xs"
            >
              <code className="truncate">{f.path}</code>
              <span className="text-muted-foreground shrink-0">
                {f.aiPrompt ? "AI" : f.inputType}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ScrollArea>
  );
};

const ScopeHeader = ({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  /** Right-aligned control (e.g. the field face's suggest wand). */
  action?: ReactNode;
}) => (
  <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
    <div className="min-w-0">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {title}
      </p>
      {subtitle ? <code className="text-sm">{subtitle}</code> : null}
    </div>
    {action}
  </div>
);

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
  const [suggesting, setSuggesting] = useState(false);
  const [exampleValue, setExampleValue] = useState<string | undefined>(
    undefined,
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
  };

  const filledByAi = field.aiPrompt !== undefined;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ScopeHeader
        action={
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
        }
        subtitle={field.path}
        title={t("templates.studio.scopeField")}
      />
      <p className="text-muted-foreground px-4 py-3 text-xs leading-relaxed">
        {t("templates.studio.fieldHelp")}
      </p>
      <FieldConfigEditor embedded field={field} onUpdate={onUpdate} />
      <div className="flex flex-col gap-2 border-t px-4 py-4">
        <Label className="text-sm">{t("templates.studio.whoFills")}</Label>
        <div className="flex items-center gap-1">
          <Button
            className="flex-1"
            onClick={() => onUpdate({ aiPrompt: undefined })}
            size="sm"
            variant={filledByAi ? "ghost" : "secondary"}
          >
            {t("templates.studio.filledByPerson")}
          </Button>
          <Button
            className="flex-1"
            onClick={() => onUpdate({ aiPrompt: field.aiPrompt ?? "" })}
            size="sm"
            variant={filledByAi ? "secondary" : "ghost"}
          >
            <WandSparklesIcon className="size-3.5" />
            {t("templates.studio.draftedByAi")}
          </Button>
        </div>
        {filledByAi ? (
          <Textarea
            onChange={(e) => onUpdate({ aiPrompt: e.target.value })}
            placeholder={t("templates.studio.aiPromptPlaceholder")}
            rows={3}
            value={field.aiPrompt}
          />
        ) : null}
      </div>
      <FieldPreview exampleValue={exampleValue} field={field} />
    </ScrollArea>
  );
};

/** Live preview of the control this field becomes in the fill form. */
const FieldPreview = ({
  field,
  exampleValue,
}: {
  field: StudioField;
  exampleValue: string | undefined;
}) => {
  const t = useTranslations();
  const label = field.label || field.path;
  return (
    <div className="flex flex-col gap-2 border-t px-4 py-4">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {t("common.preview")}
      </p>
      <div className="bg-muted/30 pointer-events-none flex flex-col gap-1.5 rounded-md border p-3">
        <Label className="text-xs">
          {label}
          {field.required ? " *" : ""}
        </Label>
        <FieldPreviewControl exampleValue={exampleValue} field={field} />
      </div>
    </div>
  );
};

const FieldPreviewControl = ({
  field,
  exampleValue,
}: {
  field: StudioField;
  exampleValue: string | undefined;
}) => {
  if (field.inputType === "textarea") {
    return <Textarea placeholder={exampleValue} readOnly rows={3} />;
  }
  if (field.inputType === "boolean") {
    return <Checkbox checked={false} />;
  }
  if (field.inputType === "select") {
    return (
      <Input placeholder={field.options.join(" / ") || exampleValue} readOnly />
    );
  }
  if (field.inputType === "date") {
    return <Input placeholder={exampleValue ?? "2026-01-31"} readOnly />;
  }
  return <Input placeholder={exampleValue} readOnly />;
};

const NameExprList = ({
  heading,
  items,
  onChange,
  addLabel,
  emptyLabel,
}: {
  heading: string;
  items: NameExpr[];
  onChange: (next: NameExpr[]) => void;
  addLabel: string;
  emptyLabel: string;
}) => {
  const t = useTranslations();
  const update = (index: number, patch: Partial<NameExpr>) =>
    onChange(
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );

  return (
    <div className="flex flex-col gap-2 px-4 py-4">
      <h3 className="text-muted-foreground text-xs font-medium">{heading}</h3>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyLabel}</p>
      ) : null}
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
      <Button
        className="justify-start gap-2"
        onClick={() => onChange([...items, { name: "", expression: "" }])}
        size="sm"
        variant="outline"
      >
        <PlusIcon />
        {addLabel}
      </Button>
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
  const slug = trimChar(collapsed, "_").slice(0, 40);
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
      return {
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
      };
    });

  // Mirror the server merge: computed fields and namespace parents (a path that
  // is only a dotted prefix of others) are not fillable inputs. This keeps the
  // display clean for templates saved before the server fix landed.
  const computedNames = new Set(
    parseNameExprs(manifest, "computed").map((c) => c.name),
  );
  const paths = fields.map((f) => f.path);
  return fields.filter(
    (f) =>
      !computedNames.has(f.path) &&
      !paths.some((p) => p !== f.path && p.startsWith(`${f.path}.`)),
  );
};

const parseNameExprs = (
  manifest: unknown,
  key: "conditions" | "computed",
): NameExpr[] => {
  if (!isRecord(manifest) || !Array.isArray(manifest[key])) {
    return [];
  }
  return manifest[key].filter(isRecord).map((raw) => ({
    name: typeof raw["name"] === "string" ? raw["name"] : "",
    expression: typeof raw["expression"] === "string" ? raw["expression"] : "",
  }));
};

const buildManifest = (
  original: unknown,
  fields: StudioField[],
  conditions: NameExpr[],
  computed: NameExpr[],
) => {
  const version =
    isRecord(original) && typeof original["version"] === "number"
      ? original["version"]
      : 1;
  return {
    version,
    fields: fields
      .filter((f) => f.path)
      .map((f) => {
        const field: {
          path: string;
          inputType: EditableField["inputType"];
          label?: string;
          required?: boolean;
          options?: string[];
          aiPrompt?: string;
        } = { path: f.path, inputType: f.inputType };
        if (f.label) {
          field.label = f.label;
        }
        if (f.required) {
          field.required = true;
        }
        if (f.options.length > 0) {
          field.options = f.options;
        }
        if (f.aiPrompt) {
          field.aiPrompt = f.aiPrompt;
        }
        return field;
      }),
    conditions: conditions.filter((c) => c.name && c.expression),
    computed: computed.filter((c) => c.name && c.expression),
  };
};
