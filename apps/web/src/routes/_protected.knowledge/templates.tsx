import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
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

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { TemplateClausesTab } from "@/routes/_protected.knowledge/-components/template-clauses-tab";
import { TemplateDocxEditor } from "@/routes/_protected.knowledge/-components/template-docx-editor";
import { TemplateForm } from "@/routes/_protected.knowledge/-components/template-form";
import { TemplateList } from "@/routes/_protected.knowledge/-components/template-list";
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
import {
  knowledgeKeys,
  templateCategoriesOptions,
  templateDetailOptions,
  templatesOptions,
} from "@/routes/_protected.knowledge/-queries";

type TemplateItem = {
  id: string;
  name: string;
  fileName: string;
  fieldCount: number;
  sizeBytes: number;
  categoryId: string | null;
  createdAt: Date;
};

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

const protectedRouteApi = getRouteApi("/_protected");

function RouteComponent() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [view, setView] = useState<View>({ kind: "list" });
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );

  const {
    data: templatesData,
    isLoading: templatesLoading,
    isError: templatesError,
  } = useQuery(templatesOptions(activeOrganizationId, selectedCategoryId));
  const { data: categoriesData } = useQuery(
    templateCategoriesOptions(activeOrganizationId),
  );

  const templates =
    templatesData && "templates" in templatesData
      ? templatesData.templates
      : [];
  const categories =
    categoriesData && "categories" in categoriesData
      ? categoriesData.categories
      : [];

  const handleCategorySelect = useCallback((id: string | null) => {
    setSelectedCategoryId(id);
  }, []);

  const invalidateTemplates = useCallback(() => {
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.templates.all(activeOrganizationId),
      })
      .catch(() => {
        /* fire-and-forget */
      });
  }, [queryClient, activeOrganizationId]);

  const invalidateCategories = useCallback(() => {
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.templateCategories.all(activeOrganizationId),
      })
      .catch(() => {
        /* fire-and-forget */
      });
  }, [queryClient, activeOrganizationId]);

  if (view.kind === "configure") {
    return (
      <ConfigureStep
        conditions={view.conditions}
        fields={view.fields}
        file={view.file}
        onBack={() => {
          setView({ kind: "list" });
          invalidateTemplates();
        }}
        onSaved={() => {
          setView({ kind: "list" });
          invalidateTemplates();
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
          invalidateTemplates();
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
          <div className="bg-success/15 dark:bg-success/15 flex size-12 items-center justify-center rounded-lg">
            <CheckCircle2Icon className="text-success size-6" />
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

  if (templatesLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.discovering")}
        </p>
      </div>
    );
  }

  if (templatesError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.loadFailed")}
        </p>
      </div>
    );
  }

  return (
    <TemplateList
      categories={categories}
      onCategoriesChanged={invalidateCategories}
      onCategorySelect={handleCategorySelect}
      onDeleted={invalidateTemplates}
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

type RenameState =
  | { status: "idle"; displayName: string }
  | {
      status: "editing";
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
        status: "editing",
        draft: action.displayName,
        displayName: action.displayName,
        saving: false,
      };
    case "cancel":
      return { status: "idle", displayName: state.displayName };
    case "setDraft":
      if (state.status !== "editing") {
        return state;
      }
      return { ...state, draft: action.value };
    case "savingStart":
      if (state.status !== "editing") {
        return state;
      }
      return { ...state, saving: true };
    case "saved":
      return {
        status: "idle",
        displayName: action.name,
      };
    case "saveFailed":
      if (state.status !== "editing") {
        return state;
      }
      return { ...state, saving: false };
    default:
      return state;
  }
};

type FieldEditState =
  | { status: "idle" }
  | {
      status: "editing";
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
        status: "editing",
        fields: action.fields,
        expandedPath: null,
        saving: false,
      };
    case "cancel":
    case "saved":
      return { status: "idle" };
    case "setExpanded":
      if (state.status !== "editing") {
        return state;
      }
      return { ...state, expandedPath: action.path };
    case "updateField":
      if (state.status !== "editing") {
        return state;
      }
      return {
        ...state,
        fields: state.fields.map((f) =>
          f.path === action.path ? { ...f, ...action.patch } : f,
        ),
      };
    case "savingStart":
      if (state.status !== "editing") {
        return state;
      }
      return { ...state, saving: true };
    case "saveFailed":
      if (state.status !== "editing") {
        return state;
      }
      return { ...state, saving: false };
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
  const queryClient = useQueryClient();

  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const {
    data: detailData,
    isLoading,
    isError,
  } = useQuery(templateDetailOptions(activeOrganizationId, template.id));

  const detail =
    detailData &&
    !(detailData instanceof Response) &&
    "presignedUrl" in detailData
      ? detailData
      : null;

  const state: "loading" | "error" | "ready" = (() => {
    if (isLoading) {
      return "loading";
    }
    if (isError || !detail) {
      return "error";
    }
    return "ready";
  })();

  const [rename, renameDispatch] = useReducer(renameReducer, {
    status: "idle",
    displayName: template.name,
  });
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCancelledRef = useRef(false);

  const [fieldEdit, fieldEditDispatch] = useReducer(fieldEditReducer, {
    status: "idle",
  });

  // Focus input when entering rename mode
  useEffect(() => {
    if (rename.status === "editing") {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [rename.status]);

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

    if (rename.status !== "editing") {
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
      .templates({ templateId: toSafeId<"template">(template.id) })
      .post({ name: trimmed });

    if (response.error) {
      renameDispatch({ type: "saveFailed" });
      renameCancelledRef.current = false;
      stellaToast.add({
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
    stellaToast.add({
      type: "success",
      title: t("templates.templateRenamed"),
    });
  }, [rename, template.id, t, onRenamed]);

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
    if (state !== "ready" || !detail) {
      return;
    }
    onFill(detail);
  }, [state, detail, onFill]);

  const startEditFields = useCallback(() => {
    if (state !== "ready" || !detail) {
      return;
    }
    const manifestFields = detail.manifest?.fields ?? [];
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
  }, [state, detail]);

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
    if (state !== "ready" || !detail) {
      return;
    }

    if (fieldEdit.status !== "editing") {
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
      conditions: detail.manifest?.conditions ?? [],
    };

    const response = await api
      .templates({ templateId: toSafeId<"template">(template.id) })
      .post({ manifest: JSON.stringify(manifest) });

    if (response.error) {
      fieldEditDispatch({ type: "saveFailed" });
      stellaToast.add({
        type: "error",
        title: t("templates.fieldUpdateFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    // Invalidate the detail query to pick up new manifest
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.templates.detail(
          activeOrganizationId,
          template.id,
        ),
      })
      .catch(() => {
        /* fire-and-forget */
      });

    fieldEditDispatch({ type: "saved" });

    stellaToast.add({
      type: "success",
      title: t("templates.fieldsUpdated"),
    });
  }, [
    state,
    detail,
    fieldEdit,
    template.id,
    t,
    queryClient,
    activeOrganizationId,
  ]);

  const fields = detail?.manifest?.fields ?? [];
  const fieldCount = detail?.manifest?.fields.length ?? template.fieldCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Button onClick={onBack} size="sm" variant="ghost">
          <ArrowLeftIcon />
          {t("templates.backToList")}
        </Button>
      </div>

      {state === "loading" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">
            {t("templates.discovering")}
          </p>
        </div>
      )}

      {state === "error" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">
            {t("templates.loadFailed")}
          </p>
        </div>
      )}

      {state === "ready" && (
        <div className="mx-auto w-full max-w-4xl overflow-y-auto p-6">
          <div className="mb-6 flex items-start justify-between">
            <div>
              {rename.status === "editing" ? (
                <Input
                  aria-label={t("templates.templateName")}
                  className="h-8 text-lg font-semibold"
                  disabled={rename.saving}
                  onBlur={() => {
                    void saveRename();
                  }}
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
              disabled={false}
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
              <TabsTab value="preview">{t("common.edit")}</TabsTab>
              <TabsTab value="clauses">{t("common.clauses")}</TabsTab>
              <TabsTab value="history">{t("common.history")}</TabsTab>
            </TabsList>

            <TabsPanel value="fields">
              {(() => {
                if (fieldEdit.status === "editing") {
                  return (
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
                                    {t(
                                      `templates.inputTypes.${field.inputType}`,
                                    )}
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
                          onClick={() => {
                            void saveFields();
                          }}
                          size="sm"
                        >
                          {t("common.save")}
                        </Button>
                      </div>
                    </div>
                  );
                }
                return (
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
                );
              })()}
            </TabsPanel>

            <TabsPanel value="preview">
              {detail && (
                <div className="h-[78vh]">
                  <TemplateDocxEditor
                    fileName={detail.fileName}
                    presignedUrl={detail.presignedUrl}
                    templateId={template.id}
                  />
                </div>
              )}
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
