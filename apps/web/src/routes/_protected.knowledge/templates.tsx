import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  PencilIcon,
  PlayIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stella/ui/components/tabs";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { TemplateClausesTab } from "@/routes/_protected.knowledge/-components/template-clauses-tab";
import { TemplateForm } from "@/routes/_protected.knowledge/-components/template-form";
import { TemplateList } from "@/routes/_protected.knowledge/-components/template-list";
import { TemplatePreview } from "@/routes/_protected.knowledge/-components/template-preview";
import { TemplateVersionsTab } from "@/routes/_protected.knowledge/-components/template-versions-tab";
import {
  buildEditableFields,
  ConfigureStep,
  FieldConfigEditor,
} from "@/routes/_protected.knowledge/-components/template-wizard";
import type {
  EditableField,
  NamedCondition,
  ResolvedField,
  StructureError,
} from "@/routes/_protected.knowledge/-components/template-wizard";
import { useTemplateAssistantStore } from "@/routes/_protected.knowledge/-store/template-assistant-store";

type ListResponse = Awaited<ReturnType<typeof api.templates.get>>;

type ListData = Exclude<
  NonNullable<Extract<ListResponse, { data: unknown }>["data"]>,
  Response
>;

type TemplateItem = ListData["templates"][number];

type DetailResponse = Awaited<
  ReturnType<ReturnType<typeof api.templates>["get"]>
>;

type DetailData = Exclude<
  NonNullable<Extract<DetailResponse, { data: unknown }>["data"]>,
  Response
>;

type View =
  | { kind: "list" }
  | {
      kind: "configure";
      file: File;
      fields: ResolvedField[];
      conditions: NamedCondition[];
      structureErrors: StructureError[];
    }
  | { kind: "detail"; template: TemplateItem }
  | {
      kind: "fill";
      template: TemplateItem;
      detail: DetailData;
    }
  | { kind: "fillDone"; filename: string };

export const Route = createFileRoute("/_protected/knowledge/templates")({
  component: RouteComponent,
});

type CategoryItem = {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
};

function RouteComponent() {
  const t = useTranslations();
  const [view, setView] = useState<View>({
    kind: "list",
  });
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);

  const fetchTemplates = useCallback(
    async (categoryId?: string | null) => {
      const query =
        categoryId !== undefined
          ? { categoryId: categoryId ?? undefined }
          : selectedCategoryId
            ? { categoryId: selectedCategoryId }
            : {};

      const response = await api.templates.get({ query });

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("templates.loadFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        setLoaded(true);
        return;
      }

      const { data } = response;
      if (data instanceof Response) {
        toastManager.add({
          type: "error",
          title: t("templates.loadFailed"),
        });
        setLoaded(true);
        return;
      }

      setTemplates(data.templates);
      setLoaded(true);
    },
    [selectedCategoryId, t],
  );

  const fetchCategories = useCallback(async () => {
    const response = await api["template-categories"].get();
    if (response.error || response.data instanceof Response) {
      return;
    }
    setCategories(response.data.categories);
  }, []);

  const handleCategorySelect = useCallback(
    (id: string | null) => {
      setSelectedCategoryId(id);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetchTemplates(id);
    },
    [fetchTemplates],
  );

  const initialFetchDone = useRef(false);
  useEffect(() => {
    if (initialFetchDone.current) {
      return;
    }
    initialFetchDone.current = true;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetchTemplates();
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetchCategories();
  }, [fetchTemplates, fetchCategories]);

  if (view.kind === "configure") {
    return (
      <ConfigureStep
        conditions={view.conditions}
        fields={view.fields}
        file={view.file}
        onBack={() => {
          setView({ kind: "list" });
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          fetchTemplates();
        }}
        onSaved={() => {
          setView({ kind: "list" });
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          fetchTemplates();
        }}
        structureErrors={view.structureErrors}
      />
    );
  }

  if (view.kind === "detail") {
    return (
      <TemplateDetail
        onBack={() => {
          setView({ kind: "list" });
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          fetchTemplates();
        }}
        onFill={(detail) =>
          setView({
            kind: "fill",
            template: view.template,
            detail,
          })
        }
        onRenamed={(newName) =>
          setView((prev) =>
            prev.kind === "detail"
              ? {
                  ...prev,
                  template: { ...prev.template, name: newName },
                }
              : prev,
          )
        }
        template={view.template}
      />
    );
  }

  if (view.kind === "fill") {
    const { manifest } = view.detail;
    const fields =
      manifest?.fields.map((f) => ({
        path: f.path,
        kind:
          f.inputType === "boolean"
            ? ("boolean" as const)
            : ("string" as const),
        count: 1,
        label: f.label,
        inputType: f.inputType,
        options: f.options,
        validation: f.validation,
        required: f.required,
      })) ?? [];

    const conditions = manifest?.conditions ?? [];

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <Button
            onClick={() =>
              setView({
                kind: "detail",
                template: view.template,
              })
            }
            size="sm"
            variant="ghost"
          >
            <ArrowLeftIcon />
            {view.template.name}
          </Button>
        </div>
        <TemplateForm
          conditions={conditions}
          fields={fields}
          fileName={view.detail.fileName}
          onBack={() =>
            setView({
              kind: "detail",
              template: view.template,
            })
          }
          onDone={(filename) => setView({ kind: "fillDone", filename })}
          structureErrors={[]}
          templateId={view.template.id}
        />
      </div>
    );
  }

  if (view.kind === "fillDone") {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <div className="flex size-12 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
            <CheckCircle2Icon className="size-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold">
              {t("templates.downloadReady")}
            </h2>
            <p className="text-muted-foreground mt-1 flex items-center justify-center gap-1.5 text-sm">
              <FileTextIcon className="size-3.5" />
              {view.filename}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setView({ kind: "list" })} variant="outline">
              {t("templates.backToList")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.discovering")}
        </p>
      </div>
    );
  }

  return (
    <TemplateList
      categories={categories}
      // eslint-disable-next-line typescript/no-misused-promises
      onCategoriesChanged={fetchCategories}
      onCategorySelect={handleCategorySelect}
      // eslint-disable-next-line typescript/no-misused-promises
      onDeleted={async () => await fetchTemplates()}
      onDiscovered={(file, schema) =>
        setView({
          kind: "configure",
          file,
          fields: schema.fields,
          conditions: schema.conditions,
          structureErrors: schema.structureErrors,
        })
      }
      onSelect={(template) => setView({ kind: "detail", template })}
      selectedCategoryId={selectedCategoryId}
      templates={templates}
    />
  );
}

type RenameState = {
  active: boolean;
  draft: string;
  displayName: string;
  saving: boolean;
};

type RenameAction =
  | { type: "start"; displayName: string }
  | { type: "cancel" }
  | { type: "setDraft"; value: string }
  | { type: "savingStart" }
  | { type: "saved"; name: string }
  | { type: "saveFailed" };

const renameReducer = (
  state: RenameState,
  action: RenameAction,
): RenameState => {
  switch (action.type) {
    case "start":
      return {
        ...state,
        active: true,
        draft: action.displayName,
      };
    case "cancel":
      return { ...state, active: false };
    case "setDraft":
      return { ...state, draft: action.value };
    case "savingStart":
      return { ...state, saving: true };
    case "saved":
      return {
        active: false,
        saving: false,
        draft: action.name,
        displayName: action.name,
      };
    case "saveFailed":
      return { ...state, saving: false };
    default:
      return state;
  }
};

type FieldEditState = {
  active: boolean;
  fields: EditableField[];
  expandedPath: string | null;
  saving: boolean;
};

type FieldEditAction =
  | { type: "start"; fields: EditableField[] }
  | { type: "cancel" }
  | { type: "setExpanded"; path: string | null }
  | { type: "updateField"; path: string; patch: Partial<EditableField> }
  | { type: "savingStart" }
  | { type: "saveFailed" }
  | { type: "saved" };

const fieldEditReducer = (
  state: FieldEditState,
  action: FieldEditAction,
): FieldEditState => {
  switch (action.type) {
    case "start":
      return {
        active: true,
        fields: action.fields,
        expandedPath: null,
        saving: false,
      };
    case "cancel":
      return {
        active: false,
        fields: [],
        expandedPath: null,
        saving: false,
      };
    case "setExpanded":
      return { ...state, expandedPath: action.path };
    case "updateField":
      return {
        ...state,
        fields: state.fields.map((f) =>
          f.path === action.path ? { ...f, ...action.patch } : f,
        ),
      };
    case "savingStart":
      return { ...state, saving: true };
    case "saveFailed":
      return { ...state, saving: false };
    case "saved":
      return {
        active: false,
        fields: [],
        expandedPath: null,
        saving: false,
      };
    default:
      return state;
  }
};

/** Template detail view: shows metadata, fields, and
 *  actions (test fill, delete). */
const TemplateDetail = ({
  template,
  onBack,
  onFill,
  onRenamed,
}: {
  template: TemplateItem;
  onBack: () => void;
  onFill: (detail: DetailData) => void;
  onRenamed: (newName: string) => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const setAssistantActive = useTemplateAssistantStore((s) => s.setActive);

  useEffect(() => {
    setAssistantActive(true, template.id, template.name);
    return () => setAssistantActive(false);
  }, [template.id, template.name, setAssistantActive]);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; detail: DetailData }
    | { kind: "error" }
  >({ kind: "loading" });

  const [rename, renameDispatch] = useReducer(renameReducer, {
    active: false,
    draft: template.name,
    displayName: template.name,
    saving: false,
  });
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCancelledRef = useRef(false);

  const [fieldEdit, fieldEditDispatch] = useReducer(fieldEditReducer, {
    active: false,
    fields: [],
    expandedPath: null,
    saving: false,
  });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const response = await api.templates({ templateId: template.id }).get();

      if (cancelled) {
        return;
      }

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("templates.loadFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        setState({ kind: "error" });
        return;
      }

      const detail = response.data;
      if (detail instanceof Response || !("presignedUrl" in detail)) {
        setState({ kind: "error" });
        return;
      }

      setState({ kind: "ready", detail });
    };

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    load();

    return () => {
      cancelled = true;
    };
  }, [template.id, t]);

  // Focus input when entering rename mode
  useEffect(() => {
    if (rename.active) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [rename.active]);

  const startRename = useCallback(() => {
    renameCancelledRef.current = false;
    renameDispatch({ type: "start", displayName: rename.displayName });
  }, [rename.displayName]);

  const cancelRename = useCallback(() => {
    renameCancelledRef.current = true;
    renameDispatch({ type: "cancel" });
  }, []);

  const saveRename = useCallback(async () => {
    if (renameCancelledRef.current) {
      return;
    }

    const trimmed = rename.draft.trim();
    if (!trimmed || trimmed === rename.displayName) {
      renameDispatch({ type: "cancel" });
      return;
    }

    renameCancelledRef.current = true;
    renameDispatch({ type: "savingStart" });
    const response = await api
      .templates({ templateId: template.id })
      .post({ name: trimmed });

    if (response.error) {
      renameDispatch({ type: "saveFailed" });
      renameCancelledRef.current = false;
      toastManager.add({
        type: "error",
        title: t("templates.renameFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    renameDispatch({ type: "saved", name: trimmed });
    onRenamed(trimmed);
    toastManager.add({
      type: "success",
      title: t("templates.templateRenamed"),
    });
  }, [rename.draft, rename.displayName, template.id, t, onRenamed]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        saveRename();
        return;
      }
      if (e.key === "Escape") {
        cancelRename();
      }
    },
    [saveRename, cancelRename],
  );

  const handleTestFill = useCallback(() => {
    if (state.kind !== "ready") {
      return;
    }
    onFill(state.detail);
  }, [state, onFill]);

  const startEditFields = useCallback(() => {
    if (state.kind !== "ready") {
      return;
    }
    const manifestFields = state.detail.manifest?.fields ?? [];
    // Convert manifest fields to ResolvedField shape
    // for buildEditableFields
    const resolved = manifestFields.map((f) => ({
      path: f.path,
      kind:
        f.inputType === "boolean" ? ("boolean" as const) : ("string" as const),
      count: 1,
      label: f.label,
      inputType: f.inputType,
      options: f.options,
      required: f.required,
    }));
    fieldEditDispatch({
      type: "start",
      fields: buildEditableFields(resolved),
    });
  }, [state]);

  const cancelEditFields = useCallback(() => {
    fieldEditDispatch({ type: "cancel" });
  }, []);

  const updateField = useCallback(
    (path: string, patch: Partial<EditableField>) => {
      fieldEditDispatch({ type: "updateField", path, patch });
    },
    [],
  );

  const saveFields = useCallback(async () => {
    if (state.kind !== "ready") {
      return;
    }

    fieldEditDispatch({ type: "savingStart" });

    const manifest = {
      version: 1,
      fields: fieldEdit.fields.map((f) => ({
        path: f.path,
        label: f.label || undefined,
        inputType: f.inputType,
        options:
          f.inputType === "select" && f.options.length > 0
            ? f.options
            : undefined,
        required: f.required || undefined,
      })),
      conditions: state.detail.manifest?.conditions ?? [],
    };

    const response = await api
      .templates({ templateId: template.id })
      .post({ manifest: JSON.stringify(manifest) });

    if (response.error) {
      fieldEditDispatch({ type: "saveFailed" });
      toastManager.add({
        type: "error",
        title: t("templates.fieldUpdateFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    // Refresh the detail to pick up new manifest
    const refreshed = await api.templates({ templateId: template.id }).get();

    if (
      !refreshed.error &&
      !(refreshed.data instanceof Response) &&
      "presignedUrl" in refreshed.data
    ) {
      setState({ kind: "ready", detail: refreshed.data });
    }

    fieldEditDispatch({ type: "saved" });

    toastManager.add({
      type: "success",
      title: t("templates.fieldsUpdated"),
    });
  }, [state, fieldEdit.fields, template.id, t]);

  const fields =
    state.kind === "ready" ? (state.detail.manifest?.fields ?? []) : [];
  const fieldCount =
    state.kind === "ready"
      ? (state.detail.manifest?.fields.length ?? template.fieldCount)
      : template.fieldCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Button onClick={onBack} size="sm" variant="ghost">
          <ArrowLeftIcon />
          {t("templates.backToList")}
        </Button>
      </div>

      {state.kind === "loading" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">
            {t("templates.discovering")}
          </p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">
            {t("templates.loadFailed")}
          </p>
        </div>
      )}

      {state.kind === "ready" && (
        <div className="mx-auto w-full max-w-2xl overflow-y-auto p-6">
          <div className="mb-6 flex items-start justify-between">
            <div>
              {rename.active ? (
                <Input
                  aria-label={t("templates.templateName")}
                  className="h-8 text-lg font-semibold"
                  disabled={rename.saving}
                  // eslint-disable-next-line typescript/no-misused-promises
                  onBlur={saveRename}
                  onChange={(e) =>
                    renameDispatch({ type: "setDraft", value: e.target.value })
                  }
                  onKeyDown={handleRenameKeyDown}
                  ref={renameInputRef}
                  value={rename.draft}
                />
              ) : (
                <button
                  className="group flex items-center gap-1.5 text-start"
                  onClick={startRename}
                  type="button"
                >
                  <h2 className="text-lg font-semibold">
                    {rename.displayName}
                  </h2>
                  <PencilIcon className="text-muted-foreground size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              )}
              <p className="text-muted-foreground mt-1 text-sm">
                {t("templates.fieldCount", {
                  count: fieldCount,
                })}
                {" \u00b7 "}
                {format.dateTime(new Date(template.createdAt), {
                  dateStyle: "medium",
                })}
              </p>
            </div>
            <Button
              disabled={state.kind !== "ready"}
              onClick={handleTestFill}
              size="sm"
              variant="outline"
            >
              <PlayIcon />
              {t("templates.testFill")}
            </Button>
          </div>

          <Tabs defaultValue="fields">
            <TabsList variant="underline">
              <TabsTab value="fields">{t("templates.fields")}</TabsTab>
              <TabsTab value="preview">{t("templates.preview")}</TabsTab>
              <TabsTab value="clauses">{t("clauses.title")}</TabsTab>
              <TabsTab value="history">{t("templates.history")}</TabsTab>
            </TabsList>

            <TabsPanel value="fields">
              {fieldEdit.active ? (
                <div className="mt-4">
                  <div className="rounded-lg border">
                    <div className="border-b px-4 py-3">
                      <h3 className="text-muted-foreground text-sm font-medium">
                        {t("templates.fieldCount", {
                          count: fieldEdit.fields.length,
                        })}
                      </h3>
                    </div>
                    <ul className="divide-y">
                      {fieldEdit.fields.map((field) => {
                        const isExpanded =
                          fieldEdit.expandedPath === field.path;
                        return (
                          <li key={field.path}>
                            <button
                              className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-start text-sm"
                              onClick={() =>
                                fieldEditDispatch({
                                  type: "setExpanded",
                                  path: isExpanded ? null : field.path,
                                })
                              }
                              type="button"
                            >
                              {isExpanded ? (
                                <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
                              ) : (
                                <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
                              )}
                              <span className="min-w-0 flex-1 font-medium">
                                {field.label || field.path}
                              </span>
                              <span className="text-muted-foreground shrink-0 text-xs">
                                {t(`templates.inputTypes.${field.inputType}`)}
                              </span>
                              {field.required && (
                                <span className="text-muted-foreground shrink-0 text-xs">
                                  *
                                </span>
                              )}
                            </button>
                            {isExpanded && (
                              <FieldConfigEditor
                                field={field}
                                onUpdate={(patch) =>
                                  updateField(field.path, patch)
                                }
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <Button
                      disabled={fieldEdit.saving}
                      onClick={cancelEditFields}
                      size="sm"
                      variant="outline"
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      disabled={fieldEdit.saving}
                      // eslint-disable-next-line typescript/no-misused-promises
                      onClick={saveFields}
                      size="sm"
                    >
                      {t("common.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                fields.length > 0 && (
                  <div className="mt-4 rounded-lg border">
                    <div className="flex items-center justify-between border-b px-4 py-3">
                      <h3 className="text-muted-foreground text-sm font-medium">
                        {t("templates.fieldCount", {
                          count: fields.length,
                        })}
                      </h3>
                      <Button
                        onClick={startEditFields}
                        size="sm"
                        variant="ghost"
                      >
                        <PencilIcon className="size-3.5" />
                        {t("templates.editFields")}
                      </Button>
                    </div>
                    <ul className="divide-y">
                      {fields.map((field) => (
                        <li
                          className="flex items-center gap-3 px-4 py-3 text-sm"
                          key={field.path}
                        >
                          <span className="min-w-0 flex-1 font-medium">
                            {field.label || field.path}
                          </span>
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {field.inputType
                              ? t(`templates.inputTypes.${field.inputType}`)
                              : t("templates.inputTypes.text")}
                          </span>
                          {field.required && (
                            <span className="text-muted-foreground shrink-0 text-xs">
                              *
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              )}
            </TabsPanel>

            <TabsPanel value="preview">
              <TemplatePreview templateId={template.id} />
            </TabsPanel>

            <TabsPanel value="clauses">
              <TemplateClausesTab templateId={template.id} />
            </TabsPanel>

            <TabsPanel value="history">
              <TemplateVersionsTab templateId={template.id} />
            </TabsPanel>
          </Tabs>
        </div>
      )}
    </div>
  );
};
