import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BracesIcon,
  EyeIcon,
  EyeOffIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import { getTemplateDirectives } from "@stll/folio";
import type { DirectiveRange, DocxEditorRef } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Separator } from "@stll/ui/components/separator";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import "@stll/folio/editor.css";

import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { toSafeId } from "@/lib/safe-id";
import {
  FieldConfigEditor,
  type EditableField,
} from "@/routes/_protected.knowledge/-components/template-wizard";
import {
  knowledgeKeys,
  templateDocxBufferOptions,
} from "@/routes/_protected.knowledge/-queries";

const DocxEditor = lazy(async () => {
  const m = await import("@stll/folio");
  return { default: m.DocxEditor };
});

const protectedRouteApi = getRouteApi("/_protected");

/**
 * Template Studio: the single authoring surface for a template. The document
 * (Folio) is primary on the left; a selection-scoped Inspector on the right
 * shows whole-template settings when nothing is selected, a field's settings
 * when a `{{field}}` marker is selected, and a condition when a `{{#if}}` block
 * is selected. Field metadata lives in the manifest; on save the edited
 * manifest is re-embedded (/manifest) and the bytes stored as a new version.
 */
export const TemplateStudio = ({
  templateId,
  presignedUrl,
  fileName,
  manifest,
  nameSlot,
  metaLabel,
  onBack,
  onTestFill,
  clausesSlot,
  historySlot,
}: {
  templateId: string;
  presignedUrl: string;
  fileName: string;
  manifest: unknown;
  /** The (rename-able) template name, owned by the detail view. */
  nameSlot: ReactNode;
  /** Field-count + date summary line. */
  metaLabel: string;
  onBack: () => void;
  onTestFill: () => void;
  /** Clauses + version-history panels, rendered as Inspector subtabs. */
  clausesSlot: ReactNode;
  historySlot: ReactNode;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const editorRef = useRef<DocxEditorRef>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const { containerRef, fitZoom } = useFitToWidth();

  const [fields, setFields] = useState<StudioField[]>(() =>
    parseFields(manifest),
  );
  const [conditions, setConditions] = useState<NameExpr[]>(() =>
    parseNameExprs(manifest, "conditions"),
  );
  const [computed, setComputed] = useState<NameExpr[]>(() =>
    parseNameExprs(manifest, "computed"),
  );
  const [selected, setSelected] = useState<DirectiveRange | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showDirectives, setShowDirectives] = useState(true);

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

  // Map the editor's caret to the directive it sits in, so the Inspector knows
  // which face to show. Reads the live plugin state via the captured view.
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
  }, []);

  const upsertField = useCallback(
    (path: string, patch: Partial<StudioField>) => {
      setFields((prev) => {
        const exists = prev.some((f) => f.path === path);
        if (exists) {
          return prev.map((f) => (f.path === path ? { ...f, ...patch } : f));
        }
        return [...prev, { ...defaultField(path), ...patch }];
      });
      setIsDirty(true);
    },
    [],
  );

  // The hero gesture: turn the current text selection into a `{{field}}`,
  // deriving a unique field path from the selected text and opening it in the
  // inspector (the dispatched selection change re-runs syncSelection).
  const makeField = () => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const { from, to } = view.state.selection;
    if (from === to) {
      return;
    }
    const text = view.state.doc.textBetween(from, to, " ");
    const base = slugify(text);
    let path = base;
    for (let n = 2; fields.some((f) => f.path === path); n++) {
      path = `${base}_${n}`;
    }
    view.dispatch(
      view.state.tr.insertText(`{{${path}}}`, from, to).scrollIntoView(),
    );
    view.focus();
    upsertField(path, {});
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

      setIsDirty(false);
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
    <div className="flex h-full min-h-0">
      {/* Full-bleed document — the editor is the whole left side. */}
      <div
        className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-auto"
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
            onChange={() => setIsDirty(true)}
            onEditorViewReady={(view) => {
              // Folio re-reports null on some re-renders; keep the last live
              // view so selection syncing doesn't lose its reference.
              if (view) {
                editorViewRef.current = view;
              }
            }}
            onSelectionChange={(state) => {
              setHasSelection(state?.hasSelection ?? false);
              syncSelection();
            }}
            showTemplateDirectives={showDirectives}
          />
        </Suspense>
      </div>

      {/* Inspector: all template chrome + selection settings, clauses, history. */}
      <aside className="flex w-[360px] shrink-0 flex-col border-s">
        <div className="flex items-center gap-1 border-b px-2 py-1.5">
          <Button
            aria-label={t("templates.backToList")}
            onClick={onBack}
            size="sm"
            variant="ghost"
          >
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0 flex-1">{nameSlot}</div>
          <Button
            aria-label={t("common.preview")}
            onClick={() => setShowDirectives((v) => !v)}
            size="sm"
            variant="ghost"
          >
            {showDirectives ? <EyeIcon /> : <EyeOffIcon />}
          </Button>
          <Button
            disabled={!isDirty || isSaving}
            onClick={() => void handleSave()}
            size="sm"
          >
            <SaveIcon />
            {t("common.save")}
          </Button>
        </div>

        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span className="text-muted-foreground truncate text-xs">
            {metaLabel}
          </span>
          <div className="flex-1" />
          <Button
            disabled={!hasSelection}
            onClick={makeField}
            size="sm"
            variant="outline"
          >
            <BracesIcon />
            Make field
          </Button>
          <Button onClick={onTestFill} size="sm" variant="outline">
            <PlayIcon />
            {t("templates.testFill")}
          </Button>
        </div>

        <Tabs className="flex min-h-0 flex-1 flex-col" defaultValue="fields">
          <TabsList variant="underline">
            <TabsTab value="fields">{t("templates.fields")}</TabsTab>
            <TabsTab value="clauses">{t("common.clauses")}</TabsTab>
            <TabsTab value="history">{t("common.history")}</TabsTab>
          </TabsList>
          <TabsPanel className="min-h-0 flex-1" value="fields">
            <Inspector
              conditions={conditions}
              computed={computed}
              fields={fields}
              onConditionsChange={(next) => {
                setConditions(next);
                setIsDirty(true);
              }}
              onComputedChange={(next) => {
                setComputed(next);
                setIsDirty(true);
              }}
              onFieldUpdate={upsertField}
              selected={selected}
            />
          </TabsPanel>
          <TabsPanel className="min-h-0 flex-1 overflow-auto" value="clauses">
            {clausesSlot}
          </TabsPanel>
          <TabsPanel className="min-h-0 flex-1 overflow-auto" value="history">
            {historySlot}
          </TabsPanel>
        </Tabs>
      </aside>
    </div>
  );
};

// ── Inspector ────────────────────────────────────────────

type StudioField = EditableField & { aiPrompt: string | undefined };
type NameExpr = { name: string; expression: string };

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
  if (selected && selected.kind === "placeholder") {
    const field =
      fields.find((f) => f.path === selected.expr) ??
      defaultField(selected.expr);
    return (
      <ScrollArea className="min-h-0 flex-1">
        <ScopeHeader title="Field" subtitle={field.path} />
        <FieldConfigEditor
          field={field}
          onUpdate={(patch) => onFieldUpdate(field.path, patch)}
        />
        <AiDraftControl
          aiPrompt={field.aiPrompt}
          onChange={(aiPrompt) => onFieldUpdate(field.path, { aiPrompt })}
        />
      </ScrollArea>
    );
  }

  if (selected && (selected.kind === "if" || selected.kind === "elseif")) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <ScopeHeader title="Condition" subtitle={selected.kind} />
        <div className="px-4 py-4">
          <p className="text-muted-foreground text-xs leading-relaxed">
            This block shows only when:
          </p>
          <code className="bg-muted mt-2 block rounded px-3 py-2 text-xs">
            {selected.expr || "—"}
          </code>
          <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
            Named conditions are managed in Template settings (click empty space
            in the document).
          </p>
        </div>
      </ScrollArea>
    );
  }

  if (selected && selected.kind === "clause") {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <ScopeHeader title="Clause slot" subtitle={selected.expr} />
        <div className="text-muted-foreground px-4 py-4 text-xs leading-relaxed">
          A clause from the library is inserted here at fill time. Manage linked
          clauses in the Clauses tab.
        </div>
      </ScrollArea>
    );
  }

  // Default: whole-template settings.
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ScopeHeader title="Template" />
      <NameExprList
        addLabel="Add condition"
        emptyLabel="No conditions yet."
        heading="Conditions"
        items={conditions}
        onChange={onConditionsChange}
      />
      <Separator />
      <NameExprList
        addLabel="Add computed field"
        emptyLabel="No computed fields yet."
        heading="Computed"
        items={computed}
        onChange={onComputedChange}
      />
      <Separator />
      <div className="px-4 py-4">
        <h3 className="text-muted-foreground mb-2 text-xs font-medium">
          Fields ({fields.length})
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
}: {
  title: string;
  subtitle?: string;
}) => (
  <div className="border-b px-4 py-3">
    <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
      {title}
    </p>
    {subtitle ? <code className="text-sm">{subtitle}</code> : null}
  </div>
);

const AiDraftControl = ({
  aiPrompt,
  onChange,
}: {
  aiPrompt: string | undefined;
  onChange: (value: string | undefined) => void;
}) => {
  const enabled = aiPrompt !== undefined;
  return (
    <div className="flex flex-col gap-2 border-t px-4 py-4">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={enabled}
          onCheckedChange={(checked) => onChange(checked ? "" : undefined)}
        />
        <Label className="flex items-center gap-1.5 text-sm">
          <WandSparklesIcon className="size-3.5" />
          AI-drafted
        </Label>
      </div>
      {enabled ? (
        <Textarea
          onChange={(e) => onChange(e.target.value)}
          placeholder="Describe what AI should draft for this field, e.g. the scope of this power of attorney."
          rows={3}
          value={aiPrompt}
        />
      ) : null}
    </div>
  );
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
              placeholder="name"
              value={item.name}
            />
            <Button
              aria-label="Remove"
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
            placeholder="expression"
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
  // oxlint-disable-next-line sonarjs/slow-regex -- runs on one short text selection
  const collapsed = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_");
  const slug = trimChar(collapsed, "_").slice(0, 40);
  return slug.length > 0 ? slug : "field";
};

const defaultField = (path: string): StudioField => ({
  path,
  kind: "string",
  label: "",
  inputType: "text",
  required: false,
  options: [],
  aiPrompt: undefined,
});

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
