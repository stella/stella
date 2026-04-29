import { Suspense, useEffect, useRef, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { PlusIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stella/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@stella/ui/components/field";
import { Input } from "@stella/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { Skeleton } from "@stella/ui/components/skeleton";
import { Tabs, TabsList, TabsTab } from "@stella/ui/components/tabs";
import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

import { PDF_MIME_TYPE } from "@/consts";
import type {
  PropertyDependency,
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspacePropertyOption,
} from "@/lib/types";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import { PropertyPromptInput } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import type { PropertyPromptFieldHandle } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import { SelectOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/select-options";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { useActiveView } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-active-view";
import { usePropertiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import {
  useCreateProperty,
  usePreviewProperty,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import { useEntitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type CreatePropertyProps = {
  workspaceId: string;
};

type CreationMode = "ai" | "manual";

type CreatableContentType =
  | "text"
  | "single-select"
  | "multi-select"
  | "date"
  | "int";

const CREATION_MODES = [
  "ai",
  "manual",
] as const satisfies readonly CreationMode[];

const PROPERTY_TYPES = [
  "text",
  "single-select",
  "multi-select",
  "date",
  "int",
] as const satisfies readonly CreatableContentType[];

const isCreatableContentType = (
  value: unknown,
): value is CreatableContentType =>
  typeof value === "string" &&
  (PROPERTY_TYPES as readonly string[]).includes(value);

const isCreationMode = (value: unknown): value is CreationMode =>
  typeof value === "string" &&
  (CREATION_MODES as readonly string[]).includes(value);

const isAIPreviewable = (entity: WorkspaceEntity): boolean =>
  Object.values(entity.fields).some(
    (f) =>
      f.content.type === "file" &&
      (f.content.mimeType === PDF_MIME_TYPE || f.content.pdfFileId !== null),
  );

export const CreateProperty = ({ workspaceId }: CreatePropertyProps) => {
  const isLimitReached = usePropertiesCountLimit(workspaceId);
  // Lifted out of the dialog body so the in-flight mutation survives
  // a close/reopen cycle. Without this, conditionally unmounting the
  // body would drop `isPending` and the user could submit twice.
  const createProperty = useCreateProperty({ workspaceId });
  const [dialogOpen, setDialogOpen] = useState(false);

  if (isLimitReached) {
    return null;
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        // Block closing while a create is in flight so the request
        // can't be orphaned and re-submitted on reopen.
        if (!open && createProperty.isPending) {
          return;
        }
        setDialogOpen(open);
      }}
      open={dialogOpen}
    >
      <DialogTrigger
        render={
          <Button
            className="hover:bg-accent h-full! min-w-10 rounded-none"
            size="icon"
            type="button"
            variant="ghost"
          />
        }
      >
        <PlusIcon />
      </DialogTrigger>

      <DialogPopup className="sm:max-w-3xl">
        {dialogOpen && (
          <Suspense fallback={<DialogLoading />}>
            <CreatePropertyDialogBody
              createProperty={createProperty}
              onClose={() => setDialogOpen(false)}
              workspaceId={workspaceId}
            />
          </Suspense>
        )}
      </DialogPopup>
    </Dialog>
  );
};

const DialogLoading = () => (
  <DialogPanel className="space-y-4 p-4">
    <Skeleton className="h-8 w-1/3" />
    <Skeleton className="h-32 w-full" />
  </DialogPanel>
);

type DialogBodyProps = {
  workspaceId: string;
  onClose: () => void;
  createProperty: ReturnType<typeof useCreateProperty>;
};

const CreatePropertyDialogBody = ({
  workspaceId,
  onClose,
  createProperty,
}: DialogBodyProps) => {
  const t = useTranslations();
  const previewProperty = usePreviewProperty();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const activeView = useActiveView();
  const { data: entitiesData } = useSuspenseQuery(
    useEntitiesOptions(activeView),
  );

  const fileProperty = properties.find((p) => p.content.type === "file");
  const previewableEntities = entitiesData.entities.filter(isAIPreviewable);
  const defaultPreviewEntityId =
    previewableEntities.at(0)?.entityId ??
    entitiesData.entities.at(0)?.entityId ??
    null;

  const [mode, setMode] = useState<CreationMode>("ai");
  const [contentType, setContentType] = useState<CreatableContentType>("text");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mentions, setMentions] = useState<string[]>(() =>
    fileProperty ? [fileProperty.id] : [],
  );
  const [promptTouched, setPromptTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [options, setOptions] = useState<WorkspacePropertyOption[]>([]);
  const [previewState, setPreviewState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [previewValue, setPreviewValue] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewEntityId, setPreviewEntityId] = useState(
    defaultPreviewEntityId,
  );

  const previewEntity = previewEntityId
    ? (entitiesData.entities.find((e) => e.entityId === previewEntityId) ??
      null)
    : null;

  // Editor lives in state (not ref) so that auto-prompt useEffect
  // re-fires once Tiptap calls `onEditorReady` after mount. A ref
  // wouldn't trigger the dependency change.
  const [editor, setEditor] = useState<Editor | null>(null);
  const isAutoFilling = useRef(false);
  const lastAutoKey = useRef<string | null>(null);
  // Each preview request gets a monotonic id; callbacks ignore the
  // result if a newer request has been made or the user changed the
  // configuration in flight (the stale-reset effect bumps this too).
  const previewRequestId = useRef(0);

  const propertyTypeLabels = {
    text: t("workspaces.properties.text"),
    "single-select": t("workspaces.properties.singleSelect"),
    "multi-select": t("workspaces.properties.multiSelect"),
    date: t("workspaces.properties.date"),
    int: t("workspaces.properties.int"),
  } satisfies Record<(typeof PROPERTY_TYPES)[number], string>;

  const modeLabels = {
    ai: t("workspaces.properties.aiExtraction"),
    manual: t("workspaces.properties.manualColumn"),
  } satisfies Record<CreationMode, string>;

  const inputProperties = properties;
  const propertiesById = new Map(inputProperties.map((p) => [p.id, p]));
  const selectedInputs = mentions.flatMap((id) => {
    const p = propertiesById.get(id);
    return p ? [p] : [];
  });

  const handlePromptChange = (next: string) => {
    setPrompt(next);
    if (!isAutoFilling.current) {
      setPromptTouched(true);
    }
  };

  const promptField: PropertyPromptFieldHandle = {
    name: "prompt",
    state: { value: prompt },
    handleChange: handlePromptChange,
    handleBlur: () => undefined,
  };

  // Auto-prompt: while !touched, regenerate when name or mentions change.
  // The lastAutoKey ref makes re-runs cheap, so listing every input value
  // would be redundant. Keep deps narrow: name + mentions are the only
  // user-driven triggers; mode/promptTouched/editor identity gate inside.
  const mentionsKey = mentions.join(",");
  useEffect(() => {
    if (!editor || promptTouched || mode !== "ai") {
      return;
    }
    const key = `${name}|${mentionsKey}`;
    if (key === lastAutoKey.current) {
      return;
    }
    lastAutoKey.current = key;

    const namePart = name.trim() || t("workspaces.properties.unnamedColumn");

    const paragraphContent: object[] = [
      {
        type: "text",
        text: t("workspaces.properties.defaultPromptPrefix", {
          propertyName: namePart,
        }),
      },
    ];
    for (const [i, p] of selectedInputs.entries()) {
      if (i > 0) {
        paragraphContent.push({ type: "text", text: ", " });
      }
      paragraphContent.push({
        type: "mention",
        attrs: { id: p.id, label: p.name },
      });
    }
    paragraphContent.push({ type: "text", text: "." });

    isAutoFilling.current = true;
    editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph", content: paragraphContent }],
    });
    isAutoFilling.current = false;
  }, [editor, name, mentionsKey, promptTouched, mode, selectedInputs, t]);

  // Stale preview: any config change invalidates the displayed result
  // (and any in-flight request) so users don't confuse it with the
  // current settings.
  useEffect(() => {
    previewRequestId.current += 1;
    setPreviewState("idle");
    setPreviewValue(null);
    setPreviewError(null);
  }, [prompt, contentType, mentionsKey, options, previewEntityId]);

  const trimmedName = name.trim();
  const hasMentions = mentions.length > 0;
  const aiReady = prompt.length > 0 && hasMentions;
  const canSubmit = trimmedName.length > 0 && (mode === "manual" || aiReady);
  const showMentionsError = mode === "ai" && submitAttempted && !hasMentions;

  const resetForm = () => {
    setMode("ai");
    setContentType("text");
    setName("");
    setPrompt("");
    setMentions(fileProperty ? [fileProperty.id] : []);
    setPromptTouched(false);
    setSubmitAttempted(false);
    setOptions([]);
    setPreviewState("idle");
    setPreviewValue(null);
    lastAutoKey.current = null;
  };

  const pushOption = (option: WorkspacePropertyOption) => {
    setOptions((prev) => [...prev, option]);
  };
  const removeOptionAt = (index: number) => {
    setOptions((prev) => prev.filter((_, i) => i !== index));
  };
  const replaceOptionAt = (index: number, option: WorkspacePropertyOption) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? option : o)));
  };

  const handleOpenChange = () => {
    onClose();
    resetForm();
  };

  const toggleInput = (property: WorkspaceProperty) => {
    // While the prompt is untouched, just nudge `mentions` — the
    // auto-prompt effect re-renders the whole sentence with the
    // updated input list. This avoids any direct editor mutation
    // (which would otherwise trip `promptTouched`).
    if (!promptTouched) {
      setMentions((prev) =>
        prev.includes(property.id)
          ? prev.filter((id) => id !== property.id)
          : [...prev, property.id],
      );
      return;
    }

    if (!editor) {
      return;
    }
    const isSelected = mentions.includes(property.id);

    if (isSelected) {
      const ranges: [number, number][] = [];
      editor.state.doc.descendants((node, pos) => {
        if (
          node.type.name === "mention" &&
          (node.attrs as { id?: string }).id === property.id
        ) {
          ranges.push([pos, pos + node.nodeSize]);
        }
      });
      if (ranges.length === 0) {
        return;
      }
      let tr = editor.state.tr;
      for (const [from, to] of ranges.toReversed()) {
        tr = tr.delete(from, to);
      }
      editor.view.dispatch(tr);
      return;
    }

    editor
      .chain()
      .focus("end")
      .insertContent({
        type: "mention",
        attrs: { id: property.id, label: property.name },
      })
      .insertContent(" ")
      .run();
  };

  const runPreview = () => {
    if (!previewEntity) {
      return;
    }
    previewRequestId.current += 1;
    const requestId = previewRequestId.current;
    setPreviewState("loading");
    setPreviewValue(null);
    setPreviewError(null);

    const isCurrent = () => requestId === previewRequestId.current;

    previewProperty.mutate(
      {
        workspaceId,
        prompt,
        contentType,
        entityId: previewEntity.entityId,
        ...((contentType === "single-select" ||
          contentType === "multi-select") &&
        options.length > 0
          ? { options }
          : {}),
        ...(mentions.length > 0
          ? {
              dependencies: mentions.map((id) => ({
                dependsOnPropertyId: id,
              })),
            }
          : {}),
      },
      {
        onSuccess: (data) => {
          if (!isCurrent()) {
            return;
          }
          if (data.status === "ready") {
            setPreviewValue(formatPreviewContent(data.content));
            setPreviewState("ready");
            return;
          }
          if (data.status === "unsupported") {
            setPreviewError(t("workspaces.properties.previewUnsupported"));
          } else if (data.status === "skipped") {
            setPreviewError(t("workspaces.properties.previewSkipped"));
          } else {
            setPreviewError(t("workspaces.properties.previewEmpty"));
          }
          setPreviewState("error");
        },
        onError: () => {
          if (!isCurrent()) {
            return;
          }
          setPreviewError(t("errors.actionFailed"));
          setPreviewState("error");
        },
      },
    );
  };

  const handleCreate = () => {
    setSubmitAttempted(true);
    if (!canSubmit) {
      return;
    }

    const dependencies: PropertyDependency[] =
      mode === "ai"
        ? mentions.map((id) => ({ dependsOnPropertyId: id, condition: null }))
        : [];

    const isSelectType =
      contentType === "single-select" || contentType === "multi-select";

    createProperty.mutate(
      {
        name: trimmedName,
        contentType,
        toolType: mode === "manual" ? "manual-input" : "ai-model",
        ...(mode === "ai" ? { prompt, dependencies } : {}),
        ...(isSelectType && options.length > 0 ? { options } : {}),
      },
      {
        onSuccess: () => {
          handleOpenChange();
        },
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const outputLabel = trimmedName || t("workspaces.properties.unnamedColumn");

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("workspaces.properties.newColumn")}</DialogTitle>
        <DialogDescription>
          {t("workspaces.properties.newColumnDescription")}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel className="space-y-4">
        <Tabs
          onValueChange={(value) => {
            if (isCreationMode(value)) {
              setMode(value);
              setSubmitAttempted(false);
            }
          }}
          value={mode}
        >
          <TabsList className="w-full">
            {CREATION_MODES.map((value) => (
              <TabsTab key={value} value={value}>
                {modeLabels[value]}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>

        <div className="space-y-4">
          <div className="space-y-4">
            <Field>
              <FieldLabel>{t("common.name")}</FieldLabel>
              <Input
                autoComplete="off"
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) {
                    handleCreate();
                  }
                }}
                placeholder={t("workspaces.properties.newColumnName")}
                value={name}
              />
            </Field>

            <Field>
              <FieldLabel>{t("workspaces.properties.resultType")}</FieldLabel>
              <Select
                onValueChange={(value) => {
                  if (isCreatableContentType(value)) {
                    setContentType(value);
                  }
                }}
                value={contentType}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {PROPERTY_TYPES.map((type) => (
                    <SelectItem
                      key={type}
                      label={propertyTypeLabels[type]}
                      value={type}
                    >
                      <PropertyIcon
                        className="text-muted-foreground"
                        type={type}
                      />
                      <span>{propertyTypeLabels[type]}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            {(contentType === "single-select" ||
              contentType === "multi-select") && (
              <Field>
                <FieldLabel>
                  {t("workspaces.properties.optionsLabel")}
                </FieldLabel>
                <SelectOptions
                  fieldName="options"
                  options={options}
                  pushValue={pushOption}
                  removeValue={removeOptionAt}
                  replaceValue={replaceOptionAt}
                />
                <FieldDescription>
                  {t("workspaces.properties.optionsHelp")}
                </FieldDescription>
              </Field>
            )}

            {mode === "ai" && (
              <>
                <Field>
                  <FieldLabel>{t("workspaces.properties.inputs")}</FieldLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {inputProperties.map((property) => {
                      const selected = mentions.includes(property.id);
                      return (
                        <button
                          aria-pressed={selected}
                          className={cn(
                            "hover:bg-accent flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                            selected
                              ? "bg-accent border-foreground/40 text-foreground"
                              : "text-muted-foreground border-border",
                          )}
                          key={property.id}
                          onClick={() => toggleInput(property)}
                          type="button"
                        >
                          <PropertyIcon
                            className="size-3.5"
                            type={property.content.type}
                          />
                          <span className="truncate">{property.name}</span>
                        </button>
                      );
                    })}
                  </div>
                  <FieldDescription>
                    {t("workspaces.properties.inputsHelp")}
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel>
                    {t("workspaces.properties.extractionInstruction")}
                  </FieldLabel>
                  <PropertyPromptInput
                    autoPopulateOnEmpty={false}
                    field={promptField}
                    onEditorReady={setEditor}
                    onMentionsChange={setMentions}
                    propertyId=""
                    propertyName={trimmedName}
                    workspaceId={workspaceId}
                  />
                  {showMentionsError ? (
                    <p className="text-destructive-foreground text-xs">
                      {t("workspaces.properties.addInputProperty")}
                    </p>
                  ) : (
                    <FieldDescription>
                      {t("workspaces.properties.extractionInstructionHelp")}
                    </FieldDescription>
                  )}
                </Field>

                <DependencyFlow
                  inputs={selectedInputs}
                  outputContentType={contentType}
                  outputLabel={outputLabel}
                />
              </>
            )}
          </div>

          {mode === "ai" && (
            <PreviewBlock
              entityOptions={previewableEntities}
              isReady={canSubmit}
              onEntityChange={setPreviewEntityId}
              onRun={runPreview}
              previewEntityId={previewEntityId}
              previewError={previewError}
              previewState={previewState}
              previewValue={previewValue}
            />
          )}
        </div>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={createProperty.isPending || trimmedName.length === 0}
          loading={createProperty.isPending}
          onClick={handleCreate}
        >
          {t("workspaces.properties.createColumn")}
        </Button>
      </DialogFooter>
    </>
  );
};

type DependencyFlowProps = {
  inputs: WorkspaceProperty[];
  outputContentType: CreatableContentType;
  outputLabel: string;
};

const DependencyFlow = ({
  inputs,
  outputContentType,
  outputLabel,
}: DependencyFlowProps) => {
  const t = useTranslations();

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {inputs.length === 0 ? (
        <span className="italic">
          {t("workspaces.properties.flowNoInputs")}
        </span>
      ) : (
        inputs.map((p, i) => (
          <span className="flex items-center gap-1" key={p.id}>
            <PropertyIcon className="size-3.5" type={p.content.type} />
            <span className="text-foreground">{p.name}</span>
            {i < inputs.length - 1 && <span className="ms-1">·</span>}
          </span>
        ))
      )}
      <FlowSeparator />
      <SparklesIcon className="size-3.5" />
      <span>{t("workspaces.properties.flowExtraction")}</span>
      <FlowSeparator />
      <PropertyIcon className="size-3.5" type={outputContentType} />
      <span className="text-foreground truncate">{outputLabel}</span>
    </div>
  );
};

const FlowSeparator = () => (
  <span aria-hidden className="text-muted-foreground/50">
    →
  </span>
);

type PreviewBlockProps = {
  entityOptions: WorkspaceEntity[];
  isReady: boolean;
  onEntityChange: (entityId: string) => void;
  onRun: () => void;
  previewEntityId: string | null;
  previewState: "idle" | "loading" | "ready" | "error";
  previewValue: string | null;
  previewError: string | null;
};

const PreviewBlock = ({
  entityOptions,
  isReady,
  onEntityChange,
  onRun,
  previewEntityId,
  previewState,
  previewValue,
  previewError,
}: PreviewBlockProps) => {
  const t = useTranslations();
  // Require the selected entity to still be in the options list — if
  // the active view changed and the selection no longer resolves,
  // disable Preview rather than firing a request that no-ops.
  const hasEntity =
    previewEntityId !== null &&
    entityOptions.some((e) => e.entityId === previewEntityId);

  return (
    <div className="bg-muted/40 space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex items-center gap-2">
        {hasEntity ? (
          <Select
            onValueChange={(value) => {
              if (typeof value === "string") {
                onEntityChange(value);
              }
            }}
            value={previewEntityId}
          >
            <SelectTrigger className="flex-1" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {entityOptions.map((entity) => {
                const file = getFirstFile(entity);
                const label = entity.name ?? file?.fileName ?? "Untitled";
                return (
                  <SelectItem
                    key={entity.entityId}
                    label={label}
                    value={entity.entityId}
                  >
                    <EntityKindIcon
                      className="text-muted-foreground size-3.5 shrink-0"
                      kind={entity.kind}
                      mimeType={file?.mimeType ?? null}
                    />
                    <span className="truncate">{label}</span>
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        ) : (
          <div className="text-muted-foreground flex-1 text-xs">
            {t("workspaces.properties.noFirstDocument")}
          </div>
        )}
        <Button
          disabled={!isReady || !hasEntity || previewState === "loading"}
          loading={previewState === "loading"}
          onClick={onRun}
          size="sm"
          variant="outline"
        >
          <SparklesIcon />
          {t("common.preview")}
        </Button>
      </div>

      {previewState === "ready" && previewValue !== null && (
        <div className="bg-background rounded-md border p-2">
          <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
            {t("workspaces.properties.flowOutput")}
          </div>
          <div className="text-foreground mt-0.5 text-sm break-words">
            {previewValue}
          </div>
        </div>
      )}

      {previewState === "error" && previewError !== null && (
        <p className="text-destructive-foreground text-xs">{previewError}</p>
      )}
    </div>
  );
};

type PreviewContent =
  | { type: "text"; value: string }
  | { type: "single-select"; value: string | null }
  | { type: "multi-select"; value: string[] }
  | { type: "date"; value: string | null }
  | { type: "int"; value: number; currency: string | null };

const formatPreviewContent = (content: PreviewContent): string => {
  if (content.type === "text") {
    return content.value;
  }
  if (content.type === "single-select") {
    return content.value ?? "—";
  }
  if (content.type === "multi-select") {
    return content.value.length > 0 ? content.value.join(", ") : "—";
  }
  if (content.type === "date") {
    return content.value ?? "—";
  }
  return content.currency
    ? `${content.value} ${content.currency}`
    : String(content.value);
};
