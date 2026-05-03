import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
} from "@stll/ui/components/combobox";
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
} from "@stll/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Skeleton } from "@stll/ui/components/skeleton";
import { Tabs, TabsList, TabsTab } from "@stll/ui/components/tabs";
import { toastManager } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import {
  keepPreviousData,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { LoaderIcon, PlusIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { CHAT_MENTION_ENTITY_RESULT_LIMIT } from "@/components/chat-mention-helpers";
import type {
  PropertyDependency,
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspacePropertyOption,
} from "@/lib/types";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import type { PropertyPromptFieldHandle } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import { PropertyPromptInput } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import { SelectOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/select-options";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { useActiveView } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-active-view";
import { usePropertiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import {
  useCreateProperty,
  usePreviewProperty,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type CreatePropertyProps = {
  workspaceId: string;
  /**
   * Visual presentation of the trigger:
   *  - `icon` (default): bare "+" button used in the table's
   *    column-header row, where space is tight and the label
   *    would dominate the column.
   *  - `labelled`: full "+ Nový sloupec" pill used in the view
   *    toolbar so the action is discoverable next to the other
   *    chip-shaped controls.
   *  - `panel`: full-width action used in side panels.
   */
  triggerVariant?: "icon" | "labelled" | "panel";
  extractionContext?: {
    entityId: string;
    filePropertyId: string | null;
  };
  open?: boolean;
  onCreated?: (result: CreatePropertyResult) => void;
  onOpenChange?: (open: boolean) => void;
};

type CreationMode = "ai" | "manual";
type ExtractionScope = "file" | "matter";

type CreatePropertyResult = {
  mode: CreationMode;
  property: WorkspaceProperty;
  extractionScope?: ExtractionScope;
  entityId?: string;
};

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

const createPropertyContent = (
  contentType: CreatableContentType,
  options: WorkspacePropertyOption[],
): WorkspaceProperty["content"] => {
  if (contentType === "single-select" || contentType === "multi-select") {
    return {
      version: 1,
      type: contentType,
      options,
      fallback: null,
    };
  }

  return {
    version: 1,
    type: contentType,
  };
};

const sameStringList = (left: string[], right: string[]) =>
  left.length === right.length &&
  left.every((id, index) => id === right[index]);

export const CreateProperty = ({
  workspaceId,
  triggerVariant = "icon",
  extractionContext,
  open,
  onCreated,
  onOpenChange,
}: CreatePropertyProps) => {
  const t = useTranslations();
  const isLimitReached = usePropertiesCountLimit(workspaceId);
  // Lifted out of the dialog body so the in-flight mutation survives
  // a close/reopen cycle. Without this, conditionally unmounting the
  // body would drop `isPending` and the user could submit twice.
  const createProperty = useCreateProperty({ workspaceId });
  const [uncontrolledDialogOpen, setUncontrolledDialogOpen] = useState(false);
  const dialogOpen = open ?? uncontrolledDialogOpen;
  const setDialogOpen = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (open === undefined) {
      setUncontrolledDialogOpen(nextOpen);
    }
  };

  if (isLimitReached) {
    return null;
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        // Block closing while a create is in flight so the request
        // can't be orphaned and re-submitted on reopen.
        if (!nextOpen && createProperty.isPending) {
          return;
        }
        setDialogOpen(nextOpen);
      }}
      open={dialogOpen}
    >
      {triggerVariant === "labelled" ? (
        <DialogTrigger
          render={
            <Button
              className="text-muted-foreground hover:bg-accent gap-1 px-2 font-normal"
              size="xs"
              type="button"
              variant="ghost"
            />
          }
        >
          <PlusIcon className="size-3" />
          {t("workspaces.properties.newColumn")}
        </DialogTrigger>
      ) : triggerVariant === "panel" ? (
        <DialogTrigger
          render={
            <Button
              className="text-muted-foreground hover:text-foreground hover:bg-accent h-full w-full justify-start gap-2 rounded-none border-0 px-3 font-normal before:rounded-none"
              type="button"
              variant="ghost"
            />
          }
        >
          <PlusIcon className="size-4" />
          <span className="truncate">
            {t("workspaces.properties.extractEntityType")}
          </span>
        </DialogTrigger>
      ) : (
        <DialogTrigger
          render={
            <Button
              aria-label={t("workspaces.properties.newColumn")}
              className="text-muted-foreground hover:bg-accent h-full! min-w-10 rounded-none"
              size="icon"
              title={t("workspaces.properties.newColumn")}
              type="button"
              variant="ghost"
            />
          }
        >
          <PlusIcon />
        </DialogTrigger>
      )}

      <DialogPopup className="sm:max-w-3xl">
        {dialogOpen && (
          <Suspense fallback={<DialogLoading />}>
            <CreatePropertyDialogBody
              createProperty={createProperty}
              onClose={() => setDialogOpen(false)}
              workspaceId={workspaceId}
              {...(extractionContext ? { extractionContext } : {})}
              {...(onCreated ? { onCreated } : {})}
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
  extractionContext?: CreatePropertyProps["extractionContext"];
  onCreated?: (result: CreatePropertyResult) => void;
};

const CreatePropertyDialogBody = ({
  workspaceId,
  onClose,
  createProperty,
  extractionContext,
  onCreated,
}: DialogBodyProps) => {
  const t = useTranslations();
  const previewProperty = usePreviewProperty();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const activeView = useActiveView({ workspaceId });

  const fileProperties = properties.filter((p) => p.content.type === "file");
  const fileProperty = fileProperties.at(0);
  const extractionFileProperty =
    extractionContext?.filePropertyId === null ||
    extractionContext?.filePropertyId === undefined
      ? null
      : (fileProperties.find(
          (property) => property.id === extractionContext.filePropertyId,
        ) ?? null);
  const extractionFilePropertyId = extractionFileProperty?.id;

  const [mode, setMode] = useState<CreationMode>("ai");
  const [extractionScope, setExtractionScope] = useState<ExtractionScope>(
    extractionFileProperty ? "file" : "matter",
  );
  const [contentType, setContentType] = useState<CreatableContentType>("text");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mentions, setMentions] = useState<string[]>(() => {
    if (extractionContext) {
      return extractionFileProperty
        ? [extractionFileProperty.id]
        : fileProperties.map((property) => property.id);
    }

    return fileProperty ? [fileProperty.id] : [];
  });
  const [promptTouched, setPromptTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [options, setOptions] = useState<WorkspacePropertyOption[]>([]);
  const [previewState, setPreviewState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [previewValue, setPreviewValue] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewEntity, setPreviewEntity] = useState<WorkspaceEntity | null>(
    null,
  );

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

  const handlePreviewEntityChange = useCallback(
    (entity: WorkspaceEntity | null) => {
      setPreviewEntity(entity);
    },
    [],
  );

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

  const matterFilePropertyIds = fileProperties.map((property) => property.id);
  const matterFilePropertyIdsKey = matterFilePropertyIds.join(",");

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

  useEffect(() => {
    if (!extractionContext) {
      return;
    }

    let nextMentions: string[];
    if (extractionScope === "file") {
      nextMentions = extractionFilePropertyId ? [extractionFilePropertyId] : [];
    } else {
      nextMentions = matterFilePropertyIdsKey
        .split(",")
        .filter((id) => id.length > 0);
    }

    setMentions((prev) =>
      sameStringList(prev, nextMentions) ? prev : nextMentions,
    );

    if (!promptTouched) {
      lastAutoKey.current = null;
    }
  }, [
    extractionContext,
    extractionScope,
    extractionFilePropertyId,
    matterFilePropertyIdsKey,
    promptTouched,
  ]);

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
      return undefined;
    }
    const key = `${name}|${mentionsKey}`;
    if (key === lastAutoKey.current) {
      return undefined;
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

    const nextContent = {
      type: "doc",
      content: [{ type: "paragraph", content: paragraphContent }],
    };
    let cancelled = false;

    const timeoutId = window.setTimeout(() => {
      if (cancelled || editor.isDestroyed) {
        return;
      }

      isAutoFilling.current = true;
      editor.commands.setContent(nextContent);
      isAutoFilling.current = false;
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [editor, name, mentionsKey, promptTouched, mode, selectedInputs, t]);

  // Stale preview: any config change invalidates the displayed result
  // (and any in-flight request) so users don't confuse it with the
  // current settings.
  useEffect(() => {
    previewRequestId.current += 1;
    setPreviewState("idle");
    setPreviewValue(null);
    setPreviewError(null);
  }, [prompt, contentType, mentionsKey, options, previewEntity]);

  const trimmedName = name.trim();
  const hasMentions = mentions.length > 0;
  const aiReady = prompt.length > 0 && hasMentions;
  const canSubmit = trimmedName.length > 0 && (mode === "manual" || aiReady);
  const showMentionsError = mode === "ai" && submitAttempted && !hasMentions;

  const resetForm = () => {
    setMode("ai");
    setExtractionScope(extractionFileProperty ? "file" : "matter");
    setContentType("text");
    setName("");
    setPrompt("");
    if (extractionContext) {
      setMentions(
        extractionFileProperty
          ? [extractionFileProperty.id]
          : matterFilePropertyIds,
      );
    } else {
      setMentions(fileProperty ? [fileProperty.id] : []);
    }
    setPromptTouched(false);
    setSubmitAttempted(false);
    setOptions([]);
    setPreviewState("idle");
    setPreviewValue(null);
    setPreviewEntity(null);
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
        onSuccess: (data) => {
          const result: CreatePropertyResult = {
            mode,
            property: {
              id: data.id,
              workspaceId,
              name: trimmedName,
              createdAt: new Date(),
              // Mirrors the server-side initial status: AI properties
              // need a first workflow run; manual ones are ready.
              status: mode === "manual" ? "fresh" : "stale",
              content: createPropertyContent(contentType, options),
              tool:
                mode === "manual"
                  ? { version: 1, type: "manual-input" }
                  : {
                      version: 1,
                      type: "ai-model",
                      prompt,
                      dependencies,
                    },
            },
            ...(extractionContext
              ? {
                  entityId: extractionContext.entityId,
                  extractionScope,
                }
              : {}),
          };
          handleOpenChange();
          onCreated?.(result);
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
        <DialogTitle>
          {extractionContext
            ? t("workspaces.properties.extractEntityType")
            : t("workspaces.properties.newColumn")}
        </DialogTitle>
        <DialogDescription>
          {extractionContext
            ? t("workspaces.properties.extractEntityTypeDescription")
            : t("workspaces.properties.newColumnDescription")}
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
                {extractionContext && (
                  <ExtractionScopeField
                    allFileCount={fileProperties.length}
                    currentFilePropertyName={extractionFileProperty?.name}
                    onChange={setExtractionScope}
                    value={extractionScope}
                  />
                )}

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
              activeView={activeView}
              isReady={canSubmit}
              onEntityChange={handlePreviewEntityChange}
              onRun={runPreview}
              previewEntity={previewEntity}
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

type ExtractionScopeFieldProps = {
  value: ExtractionScope;
  currentFilePropertyName: string | undefined;
  allFileCount: number;
  onChange: (scope: ExtractionScope) => void;
};

const ExtractionScopeField = ({
  value,
  currentFilePropertyName,
  allFileCount,
  onChange,
}: ExtractionScopeFieldProps) => {
  const t = useTranslations();
  const options = [
    {
      value: "file",
      label: t("workspaces.properties.scopeFile"),
      description: currentFilePropertyName
        ? t("workspaces.properties.scopeFileDescription", {
            property: currentFilePropertyName,
          })
        : t("workspaces.properties.scopeFileUnavailable"),
      disabled: currentFilePropertyName === undefined,
    },
    {
      value: "matter",
      label: t("workspaces.properties.scopeMatter"),
      description: t("workspaces.properties.scopeMatterDescription"),
      disabled: allFileCount === 0,
    },
  ] satisfies {
    value: ExtractionScope;
    label: string;
    description: string;
    disabled: boolean;
  }[];

  return (
    <Field>
      <FieldLabel>{t("workspaces.properties.extractionScope")}</FieldLabel>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <button
            aria-pressed={value === option.value}
            className={cn(
              "hover:bg-accent rounded-md border p-3 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              value === option.value
                ? "border-foreground/40 bg-accent text-foreground"
                : "border-border text-muted-foreground",
            )}
            disabled={option.disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            <span className="block text-sm font-medium">{option.label}</span>
            <span className="mt-1 block text-xs">{option.description}</span>
          </button>
        ))}
      </div>
    </Field>
  );
};

type PreviewBlockProps = {
  activeView: ReturnType<typeof useActiveView>;
  isReady: boolean;
  onEntityChange: (entity: WorkspaceEntity | null) => void;
  onRun: () => void;
  previewEntity: WorkspaceEntity | null;
  previewState: "idle" | "loading" | "ready" | "error";
  previewValue: string | null;
  previewError: string | null;
};

const PreviewBlock = ({
  activeView,
  isReady,
  onEntityChange,
  onRun,
  previewEntity,
  previewState,
  previewValue,
  previewError,
}: PreviewBlockProps) => {
  const t = useTranslations();
  const hasEntity = previewEntity !== null;

  return (
    <div className="bg-muted/40 space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex items-center gap-2">
        <PreviewEntityCombobox
          activeView={activeView}
          onEntityChange={onEntityChange}
          previewEntity={previewEntity}
        />
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
          <div className="text-foreground mt-0.5 text-sm wrap-break-word">
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

type PreviewEntityComboboxProps = {
  activeView: ReturnType<typeof useActiveView>;
  onEntityChange: (entity: WorkspaceEntity | null) => void;
  previewEntity: WorkspaceEntity | null;
};

const PreviewEntityCombobox = ({
  activeView,
  onEntityChange,
  previewEntity,
}: PreviewEntityComboboxProps) => {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const debouncedSetQuery = useDebouncedCallback(
    (value: string) => setDebouncedQuery(value),
    150,
  );

  const search = debouncedQuery.trim();
  const previewEntitiesOptions = entitiesOptions({
    workspaceId: activeView.workspaceId,
    filters: activeView.filters,
    sorts: activeView.sorts,
    page: 1,
    pageSize: CHAT_MENTION_ENTITY_RESULT_LIMIT,
    fieldMode: "visible",
    previewableForAi: true,
    ...(search && { search }),
  });
  const { data, isError, isFetching } = useQuery({
    ...previewEntitiesOptions,
    placeholderData: keepPreviousData,
  });

  const entityOptions = data?.entities ?? [];
  const fallbackLabel = t("workspaces.defaultName");

  return (
    <Combobox
      itemToStringLabel={(entity) =>
        getPreviewEntityLabel(entity, fallbackLabel)
      }
      onInputValueChange={(inputValue) => {
        setQuery(inputValue);
        debouncedSetQuery(inputValue);
      }}
      onValueChange={(entity) => {
        onEntityChange(entity);
        setQuery("");
        setDebouncedQuery("");
      }}
      value={previewEntity}
    >
      <ComboboxInput
        className="flex-1"
        placeholder={t("common.search")}
        showClear
        size="sm"
        startAddon={<SearchIcon />}
        value={query}
      />
      <ComboboxPopup>
        {isFetching && (
          <ComboboxStatus className="flex items-center gap-2">
            <LoaderIcon className="size-3.5 animate-spin" />
            <span>{t("common.loading")}</span>
          </ComboboxStatus>
        )}
        {isError && !isFetching && (
          <ComboboxStatus className="text-destructive-foreground">
            {t("errors.actionFailed")}
          </ComboboxStatus>
        )}
        <ComboboxList>
          {entityOptions.map((entity) => {
            const file = getFirstFile(entity);
            const label = getPreviewEntityLabel(entity, fallbackLabel);

            return (
              <ComboboxItem key={entity.entityId} value={entity}>
                <div className="flex min-w-0 items-center gap-2">
                  <EntityKindIcon
                    className="text-muted-foreground size-3.5 shrink-0"
                    kind={entity.kind}
                    mimeType={file?.mimeType ?? null}
                  />
                  <span className="truncate">{label}</span>
                </div>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
        {!isFetching && !isError && entityOptions.length === 0 && (
          <ComboboxEmpty>
            {t("workspaces.properties.noFirstDocument")}
          </ComboboxEmpty>
        )}
      </ComboboxPopup>
    </Combobox>
  );
};

const getPreviewEntityLabel = (
  entity: WorkspaceEntity,
  fallbackLabel: string,
) => {
  const file = getFirstFile(entity);

  return entity.name ?? file?.fileName ?? fallbackLabel;
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
