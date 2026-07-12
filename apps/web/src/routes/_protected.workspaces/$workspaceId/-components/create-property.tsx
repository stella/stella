import { Suspense, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { PlusIcon, RouteIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { toSafeId } from "@/lib/safe-id";
import type {
  PropertyDependency,
  WorkspaceProperty,
  WorkspacePropertyOption,
} from "@/lib/types";
import {
  COMPOSER_CARD_CLASS,
  isCreatableContentType,
  ReadingFromRow,
  TypeChipsRow,
  useChipDefinitions,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/composer-primitives";
import type {
  CreatableContentType,
  FileChip,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/composer-primitives";
import { InlineOptionEditor } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/inline-option-editor";
import { PropertyPromptInput } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import type { PropertyPromptFieldHandle } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import {
  buildDocTypeGate,
  docTypeGateLabel,
  resolveDocumentTypeClassifier,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/group-columns";
import { usePropertiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import {
  useCreateProperty,
  useSuggestPrompt,
  useUpdateProperty,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

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
   *  - `blank-cell`: full-cell action used in the table's
   *    trailing add-column track.
   *  - `rail`: full-height table add-column rail. The whole gutter
   *    is clickable and the visible + is only an affordance.
   *  - `none`: no built-in trigger. The caller controls `open` /
   *    `onOpenChange` and renders its own trigger (used by the
   *    column popover's "Edit column…" item).
   */
  triggerVariant?:
    | "icon"
    | "labelled"
    | "panel"
    | "blank-cell"
    | "rail"
    | "none";
  extractionContext?: {
    entityId: string;
    filePropertyId: string | null;
  };
  /**
   * When set, the dialog opens in edit mode for the given property —
   * prefills name/type/prompt/options/fallback, and saves via the
   * update endpoint instead of create. Type changes are allowed but
   * warn the user that existing data will be cleared.
   */
  propertyId?: string;
  open?: boolean;
  onCreated?: (result: CreatePropertyResult) => void;
  onOpenChange?: (open: boolean) => void;
};

type CreatePropertyResult = {
  property: WorkspaceProperty;
  entityId?: string;
};

const buildContent = (
  contentType: CreatableContentType,
  options: WorkspacePropertyOption[],
  fallback: string | null,
): WorkspaceProperty["content"] => {
  if (contentType === "single-select" || contentType === "multi-select") {
    return {
      version: 1,
      type: contentType,
      options,
      fallback,
    };
  }
  return { version: 1, type: contentType };
};

const promptFromHtml = (html: string): string =>
  // Extract text via the DOM (inert `text/html` parse; scripts never run) for a
  // quick "is the prompt empty" check. Robust against nested/malformed tags that
  // a single-pass tag-stripping regex leaves behind.
  new DOMParser().parseFromString(html, "text/html").body.textContent.trim();

export const CreateProperty = ({
  workspaceId,
  triggerVariant = "icon",
  extractionContext,
  propertyId,
  open,
  onCreated,
  onOpenChange,
}: CreatePropertyProps) => {
  const t = useTranslations();
  const isLimitReached = usePropertiesCountLimit(workspaceId);
  const isEditMode = propertyId !== undefined;
  // Both mutations are lifted out of the dialog body so an in-flight
  // request survives a close/reopen cycle. Whichever one applies is
  // chosen inside the body based on edit mode.
  const createProperty = useCreateProperty({ workspaceId });
  const updateProperty = useUpdateProperty();
  const [uncontrolledDialogOpen, setUncontrolledDialogOpen] = useState(false);
  const dialogOpen = open ?? uncontrolledDialogOpen;
  const setDialogOpen = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (open === undefined) {
      setUncontrolledDialogOpen(nextOpen);
    }
  };

  // The "+ create" trigger variants vanish once the workspace hits the
  // property limit. Edit mode (no built-in trigger) always renders so
  // existing columns can still be opened.
  if (isLimitReached && !isEditMode) {
    return null;
  }

  const isPending = createProperty.isPending || updateProperty.isPending;

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        // Block closing while a mutation is in flight so the request
        // can't be orphaned and re-submitted on reopen.
        if (!nextOpen && isPending) {
          return;
        }
        setDialogOpen(nextOpen);
      }}
      open={dialogOpen}
    >
      {(() => {
        if (triggerVariant === "labelled") {
          return (
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
          );
        }
        if (triggerVariant === "panel") {
          return (
            <DialogTrigger
              render={
                <Button
                  className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-full w-full flex-1 justify-start gap-2 rounded-none border-0 px-3 font-normal before:rounded-none"
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
          );
        }
        if (triggerVariant === "icon") {
          return (
            <DialogTrigger
              render={
                <button
                  aria-label={t("workspaces.properties.newColumn")}
                  className="ring-ring focus-visible:ring-offset-background text-muted-foreground flex h-full w-full cursor-pointer items-center justify-center border-0 bg-transparent p-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                  data-add-property-trigger
                  data-row-expansion-ignore
                  onClick={(event) => {
                    event.currentTarget.blur();
                  }}
                  title={t("workspaces.properties.newColumn")}
                  type="button"
                />
              }
            >
              <PlusIcon className="size-4" />
            </DialogTrigger>
          );
        }
        if (triggerVariant === "blank-cell") {
          return (
            <DialogTrigger
              render={
                <button
                  aria-label={t("workspaces.properties.newColumn")}
                  className="ring-ring focus-visible:ring-offset-background absolute inset-0 z-10 cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                  data-add-property-trigger
                  data-row-expansion-ignore
                  onClick={(event) => {
                    event.currentTarget.blur();
                  }}
                  title={t("workspaces.properties.newColumn")}
                  type="button"
                />
              }
            />
          );
        }
        if (triggerVariant === "rail") {
          return (
            <DialogTrigger
              render={
                <button
                  aria-label={t("workspaces.properties.newColumn")}
                  className="group/add-column-rail ring-ring focus-visible:ring-offset-background absolute inset-0 z-10 cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                  data-add-property-trigger
                  data-row-expansion-ignore
                  onClick={(event) => {
                    event.currentTarget.blur();
                  }}
                  title={t("workspaces.properties.newColumn")}
                  type="button"
                >
                  <PlusIcon className="text-muted-foreground group-hover/add-column-rail:text-foreground group-focus-visible/add-column-rail:text-foreground absolute start-1/2 top-5 size-4 -translate-x-1/2 -translate-y-1/2 transition-colors rtl:translate-x-1/2" />
                </button>
              }
            />
          );
        }
        return null;
      })()}

      <DialogPopup className="sm:max-w-[600px]">
        {dialogOpen && (
          <Suspense fallback={<DialogLoading />}>
            <PropertyComposerBody
              createProperty={createProperty}
              onClose={() => setDialogOpen(false)}
              updateProperty={updateProperty}
              workspaceId={workspaceId}
              {...(extractionContext ? { extractionContext } : {})}
              {...(propertyId !== undefined ? { propertyId } : {})}
              {...(onCreated ? { onCreated } : {})}
            />
          </Suspense>
        )}
      </DialogPopup>
    </Dialog>
  );
};

const DialogLoading = () => (
  <div className="space-y-4 p-5">
    <Skeleton className="h-6 w-1/3" />
    <Skeleton className="h-32 w-full" />
  </div>
);

type DialogBodyProps = {
  workspaceId: string;
  onClose: () => void;
  createProperty: ReturnType<typeof useCreateProperty>;
  updateProperty: ReturnType<typeof useUpdateProperty>;
  extractionContext?: CreatePropertyProps["extractionContext"];
  propertyId?: string;
  onCreated?: (result: CreatePropertyResult) => void;
};

const PropertyComposerBody = ({
  workspaceId,
  onClose,
  createProperty,
  updateProperty,
  extractionContext,
  propertyId,
  onCreated,
}: DialogBodyProps) => {
  const t = useTranslations();
  const suggestPrompt = useSuggestPrompt();
  const startWorkflow = useStartWorkflow(workspaceId);
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));

  const editingProperty =
    propertyId === undefined
      ? null
      : (properties.find((p) => p.id === propertyId) ?? null);
  const isEditMode = propertyId !== undefined;
  // If the property vanished between trigger and render (deleted from
  // another tab), close instead of crashing on a missing record. The
  // null-render guard happens after all hooks have run so the order
  // stays stable.
  const missingForEdit = isEditMode && !editingProperty;
  useExternalSyncEffect(() => {
    if (missingForEdit) {
      onClose();
    }
  }, [missingForEdit, onClose]);

  const editingTool = editingProperty?.tool;
  const isManualEdit =
    editingTool !== undefined && editingTool.type === "manual-input";
  const showAiSections = !isManualEdit;
  const initialContentType: CreatableContentType =
    editingProperty && isCreatableContentType(editingProperty.content.type)
      ? editingProperty.content.type
      : "text";
  const initialPromptHtml =
    editingTool && editingTool.type === "ai-model" ? editingTool.prompt : "";
  const initialOptions: WorkspacePropertyOption[] =
    editingProperty &&
    (editingProperty.content.type === "single-select" ||
      editingProperty.content.type === "multi-select")
      ? editingProperty.content.options
      : [];
  const initialFallback: string | null =
    editingProperty &&
    (editingProperty.content.type === "single-select" ||
      editingProperty.content.type === "multi-select")
      ? (editingProperty.content.fallback ?? null)
      : null;

  const fileProperties = properties.filter((p) => p.content.type === "file");
  const fileProperty = fileProperties.at(0);
  const extractionFileProperty =
    extractionContext?.filePropertyId === null ||
    extractionContext?.filePropertyId === undefined
      ? null
      : (fileProperties.find(
          (property) => property.id === extractionContext.filePropertyId,
        ) ?? null);

  // Split the existing dependencies (if editing) into file-typed (which
  // become chips) and other (which live as @-mentions in the textarea).
  // Both lists are seeded into state so an unmodified Save round-trips
  // the same dependency set instead of dropping non-file deps before
  // the editor gets a chance to fire onUpdate.
  const initialDependencySplit: { fileIds: string[]; otherIds: string[] } =
    (() => {
      if (!editingProperty || editingTool?.type !== "ai-model") {
        return { fileIds: [], otherIds: [] };
      }
      const fileIds = new Set(fileProperties.map((p) => p.id));
      const inFiles: string[] = [];
      const inOther: string[] = [];
      for (const dep of editingTool.dependencies) {
        if (fileIds.has(dep.dependsOnPropertyId)) {
          inFiles.push(dep.dependsOnPropertyId);
        } else {
          inOther.push(dep.dependsOnPropertyId);
        }
      }
      return { fileIds: inFiles, otherIds: inOther };
    })();

  const initialFileIds = (() => {
    if (editingProperty && editingTool?.type === "ai-model") {
      return initialDependencySplit.fileIds;
    }
    if (extractionContext) {
      return extractionFileProperty
        ? [extractionFileProperty.id]
        : fileProperties.map((p) => p.id);
    }
    return fileProperty ? [fileProperty.id] : [];
  })();

  // Snapshot of the original conditions per dependency. Save preserves
  // these so editing name/type/prompt doesn't silently strip conditions
  // configured via the conditions sub-modal.
  const initialDependencyConditions = (() => {
    const map = new Map<string, PropertyDependency["condition"]>();
    if (editingTool?.type === "ai-model") {
      for (const dep of editingTool.dependencies) {
        map.set(dep.dependsOnPropertyId, dep.condition);
      }
    }
    return map;
  })();

  // "Applies to" scope: gate this AI column to one Document-Type subtable by
  // depending on the classifier with a `classifier == <label>` condition (the
  // same gate a playbook run writes), so the column runs only for those docs and
  // shows only in that section. Offered only when a Document Type classifier
  // exists; null means every type (ungated).
  const classifier = resolveDocumentTypeClassifier(properties);
  const docTypeOptions =
    classifier?.content.type === "single-select"
      ? classifier.content.options
      : [];
  const initialScopeDocType = (() => {
    if (!classifier || editingTool?.type !== "ai-model") {
      return null;
    }
    const gate = editingTool.dependencies.find(
      (dependency) => dependency.dependsOnPropertyId === classifier.id,
    );
    return gate ? docTypeGateLabel(gate, classifier.id) : null;
  })();

  const [contentType, setContentType] =
    useState<CreatableContentType>(initialContentType);
  const [name, setName] = useState(editingProperty?.name ?? "");
  const [prompt, setPrompt] = useState(initialPromptHtml);
  const [textareaMentions, setTextareaMentions] = useState<string[]>(
    initialDependencySplit.otherIds,
  );
  const [selectedFileIds, setSelectedFileIds] =
    useState<string[]>(initialFileIds);
  const [options, setOptions] =
    useState<WorkspacePropertyOption[]>(initialOptions);
  const [fallback, setFallback] = useState<string | null>(initialFallback);
  const [scopeDocType, setScopeDocType] = useState<string | null>(
    initialScopeDocType,
  );
  const [editor, setEditor] = useState<Editor | null>(null);

  const trimmedName = name.trim();
  const promptText = promptFromHtml(prompt);
  const needsOptions =
    contentType === "single-select" || contentType === "multi-select";
  const hasValidOptions = !needsOptions || options.length > 0;
  const typeChanged = isEditMode && contentType !== initialContentType;
  const isMutationPending =
    createProperty.isPending || updateProperty.isPending;

  // Drop the fallback selection from consumers if its target option
  // was renamed/removed, or if the user switched away from a select
  // content type. The backend rejects mismatched fallbacks; sanitising
  // here keeps the UI honest without round-tripping through setState.
  const effectiveFallback =
    fallback !== null &&
    needsOptions &&
    options.some((o) => o.value === fallback)
      ? fallback
      : null;

  // Keep the auto-included file chips in sync if the underlying
  // properties list changes (e.g., a file property is created from
  // another tab while the dialog is open). Derived rather than mirrored
  // so the source-of-truth state never drifts out of valid options.
  const validFileIds = new Set<string>(fileProperties.map((p) => p.id));
  const effectiveSelectedFileIds = selectedFileIds.filter((id) =>
    validFileIds.has(id),
  );

  const dependencyIds = [
    ...new Set([...effectiveSelectedFileIds, ...textareaMentions]),
  ];

  const availableFileToAdd = fileProperties.filter(
    (p) => !effectiveSelectedFileIds.includes(p.id),
  );

  // Manual properties skip the prompt + dependency requirements; the
  // user fills values by hand. Select-type rules still apply.
  const aiRequirementsMet =
    !showAiSections || (promptText.length > 0 && dependencyIds.length > 0);
  const canSubmit =
    trimmedName.length > 0 &&
    aiRequirementsMet &&
    hasValidOptions &&
    !isMutationPending;

  const promptField: PropertyPromptFieldHandle = {
    name: "prompt",
    state: { value: prompt },
    handleChange: setPrompt,
    handleBlur: () => undefined,
  };

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }

    // Preserve any per-dependency conditions configured via the conditions
    // sub-modal. New mentions default to null. The "Applies to" scope owns the
    // classifier slot: drop the classifier dependency only when it is (or was)
    // a scope gate, then re-add the gate below for the chosen document type. A
    // plain classifier mention with no scope is preserved with its condition.
    const dependencies: PropertyDependency[] = dependencyIds
      .filter((id) => {
        if (id !== classifier?.id) {
          return true;
        }
        return scopeDocType === null && initialScopeDocType === null;
      })
      .map((id) => ({
        dependsOnPropertyId: toSafeId<"property">(id),
        condition: initialDependencyConditions.get(id) ?? null,
      }));
    if (classifier && scopeDocType !== null) {
      dependencies.push(buildDocTypeGate(classifier.id, scopeDocType));
    }

    if (isEditMode && editingProperty) {
      const nextContent = buildContent(contentType, options, effectiveFallback);
      const nextTool: Exclude<
        WorkspaceProperty["tool"],
        { type: "playbook-verdict" }
      > =
        editingTool?.type === "manual-input"
          ? { version: 1, type: "manual-input" }
          : { version: 1, type: "ai-model", prompt, dependencies };

      updateProperty.mutate(
        {
          workspaceId,
          propertyId: editingProperty.id,
          name: trimmedName,
          content: nextContent,
          tool: nextTool,
        },
        {
          onSuccess: () => {
            // AI properties need a re-extraction after any edit since
            // the prompt, type, options, or dependencies may have
            // changed; manual properties don't have a workflow.
            if (nextTool.type === "ai-model") {
              void startWorkflow();
            }
            onClose();
          },
          onError: () => {
            stellaToast.add({
              title: t("errors.actionFailed"),
              type: "error",
            });
          },
        },
      );
      return;
    }

    const isSelectType =
      contentType === "single-select" || contentType === "multi-select";

    createProperty.mutate(
      {
        name: trimmedName,
        contentType,
        toolType: "ai-model",
        prompt,
        dependencies,
        ...(isSelectType && options.length > 0
          ? { options, fallback: effectiveFallback }
          : {}),
      },
      {
        onSuccess: (data) => {
          const result: CreatePropertyResult = {
            property: {
              id: data.id,
              workspaceId: toSafeId<"workspace">(workspaceId),
              name: trimmedName,
              createdAt: new Date(),
              status: "stale",
              content: buildContent(contentType, options, effectiveFallback),
              tool: {
                version: 1,
                type: "ai-model",
                prompt,
                dependencies,
              },
            },
            ...(extractionContext
              ? { entityId: extractionContext.entityId }
              : {}),
          };
          // Trigger the AI extraction so the new column starts populating
          // immediately. Scope to the originating entity when the dialog
          // was opened from the inspector with a file source; otherwise
          // run the whole matter.
          const workflowArgs =
            extractionContext && extractionContext.filePropertyId !== null
              ? { entityIds: [extractionContext.entityId] }
              : undefined;
          void startWorkflow(workflowArgs);
          onClose();
          onCreated?.(result);
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleAutoPrompt = () => {
    if (trimmedName.length === 0 || suggestPrompt.isPending) {
      return;
    }
    suggestPrompt.mutate(
      {
        workspaceId,
        name: trimmedName,
        contentType,
        ...(needsOptions && options.length > 0
          ? { options: options.map((o) => ({ value: o.value })) }
          : {}),
        // Send the current prompt's plain text so the LLM refines instead
        // of overwriting whatever the user already typed.
        ...(promptText.length > 0 ? { currentPrompt: promptText } : {}),
      },
      {
        onSuccess: ({ prompt: suggested }) => {
          if (!editor || editor.isDestroyed) {
            setPrompt(suggested);
            return;
          }
          editor.commands.setContent({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: suggested }],
              },
            ],
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("workspaces.properties.autoPromptFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const pushOption = (option: WorkspacePropertyOption) =>
    setOptions((prev) => [...prev, option]);
  const removeOptionAt = (index: number) =>
    setOptions((prev) => prev.filter((_, i) => i !== index));
  const replaceOptionAt = (index: number, option: WorkspacePropertyOption) =>
    setOptions((prev) => prev.map((o, i) => (i === index ? option : o)));

  if (missingForEdit) {
    return null;
  }

  return (
    <>
      <DialogTitle className="sr-only">
        {isEditMode
          ? t("workspaces.properties.editColumn")
          : t("workspaces.properties.composerTitle")}
      </DialogTitle>

      <div className="flex flex-col gap-3 px-5 pt-5 pb-4">
        <Input
          autoComplete="off"
          autoFocus
          className="text-foreground placeholder:text-foreground-placeholder w-full px-0 text-base font-semibold tracking-tight"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t("workspaces.properties.untitledColumn")}
          unstyled
          value={name}
        />

        {showAiSections ? (
          <ComposerCard
            autoPromptDisabled={
              trimmedName.length === 0 || suggestPrompt.isPending
            }
            autoPromptPending={suggestPrompt.isPending}
            contentType={contentType}
            editorReady={setEditor}
            fileChips={effectiveSelectedFileIds.map(
              (id) =>
                fileProperties.find((p) => p.id === id) ?? {
                  id,
                  name: id,
                },
            )}
            onAutoPrompt={handleAutoPrompt}
            onContentTypeChange={setContentType}
            onMentionsChange={setTextareaMentions}
            onRemoveFile={(id) =>
              setSelectedFileIds((prev) => prev.filter((p) => p !== id))
            }
            onSubmit={handleSubmit}
            promptField={promptField}
            propertyName={trimmedName}
            typeChanged={typeChanged}
            {...(availableFileToAdd.length > 0
              ? {
                  addFile: (id: string) =>
                    setSelectedFileIds((prev) => [...prev, id]),
                  availableFiles: availableFileToAdd,
                }
              : {})}
            {...(propertyId !== undefined ? { propertyId } : {})}
            workspaceId={workspaceId}
          />
        ) : (
          <ManualTypeRow
            contentType={contentType}
            onContentTypeChange={setContentType}
            typeChanged={typeChanged}
          />
        )}

        {showAiSections && classifier && docTypeOptions.length > 0 && (
          <DocumentTypeScopeRow
            classifierName={classifier.name}
            onChange={setScopeDocType}
            options={docTypeOptions}
            value={scopeDocType}
          />
        )}

        {needsOptions && (
          <InlineOptionEditor
            fallback={effectiveFallback}
            onFallbackChange={setFallback}
            options={options}
            pushOption={pushOption}
            removeOptionAt={removeOptionAt}
            replaceOptionAt={replaceOptionAt}
          />
        )}
      </div>

      <div className="bg-muted/64 flex items-center justify-end gap-2 border-t px-5 py-3">
        <DialogClose render={<Button size="sm" variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={!canSubmit}
          loading={isMutationPending}
          onClick={handleSubmit}
          size="sm"
        >
          {isEditMode
            ? t("common.saveChanges")
            : t("workspaces.properties.createColumn")}
        </Button>
      </div>
    </>
  );
};

type ComposerCardProps = {
  workspaceId: string;
  propertyId?: string;
  propertyName: string;
  promptField: PropertyPromptFieldHandle;
  onMentionsChange: (mentions: string[]) => void;
  editorReady: (editor: Editor) => void;
  onSubmit: () => void;
  contentType: CreatableContentType;
  onContentTypeChange: (next: CreatableContentType) => void;
  fileChips: FileChip[];
  onRemoveFile: (id: string) => void;
  availableFiles?: FileChip[];
  addFile?: (id: string) => void;
  onAutoPrompt: () => void;
  autoPromptDisabled: boolean;
  autoPromptPending: boolean;
  typeChanged: boolean;
};

const ComposerCard = ({
  workspaceId,
  propertyId,
  propertyName,
  promptField,
  onMentionsChange,
  editorReady,
  onSubmit,
  contentType,
  onContentTypeChange,
  fileChips,
  onRemoveFile,
  availableFiles,
  addFile,
  onAutoPrompt,
  autoPromptDisabled,
  autoPromptPending,
  typeChanged,
}: ComposerCardProps) => {
  const t = useTranslations();
  const chipDefs = useChipDefinitions();

  return (
    <div className={COMPOSER_CARD_CLASS}>
      <ReadingFromRow
        fileChips={fileChips}
        onRemoveFile={onRemoveFile}
        {...(addFile !== undefined && availableFiles !== undefined
          ? { addFile, availableFiles }
          : {})}
      />

      <PropertyPromptInput
        // The composer keeps the prompt empty on first render so the
        // user can focus the name input without the editor seeding
        // "Najdi informace…" and stealing focus. The Auto-prompt button
        // covers the seeding flow on demand.
        autoPopulateOnEmpty={false}
        field={promptField}
        onEditorReady={editorReady}
        onMentionsChange={onMentionsChange}
        onSubmit={onSubmit}
        aiEditAction={{
          disabled: autoPromptDisabled,
          isPending: autoPromptPending,
          label: t("ai.editWithAI"),
          onClick: onAutoPrompt,
        }}
        placeholder={t("workspaces.properties.extractionPlaceholder")}
        propertyId={propertyId ?? ""}
        propertyName={propertyName}
        variant="minimal"
        workspaceId={workspaceId}
      />

      <TypeChipsRow
        chipDefs={chipDefs}
        contentType={contentType}
        onContentTypeChange={onContentTypeChange}
        showSeparator
        typeChanged={typeChanged}
      />
    </div>
  );
};

// Sentinel for the "every document type" (ungated) choice; a Select value can't
// be null, so it stands in for it and maps back to null on change.
const SCOPE_ALL_VALUE = "__all__";

type DocumentTypeScopeRowProps = {
  classifierName: string;
  options: WorkspacePropertyOption[];
  value: string | null;
  onChange: (value: string | null) => void;
};

/**
 * Scopes an AI column to one Document-Type subtable (or all). Picking a type
 * gates the column so it only runs for — and only shows under — that document
 * type; "All" leaves it running for every type.
 */
const DocumentTypeScopeRow = ({
  classifierName,
  options,
  value,
  onChange,
}: DocumentTypeScopeRowProps) => {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-2 px-1">
      <RouteIcon className="text-muted-foreground size-4 shrink-0" />
      <span className="text-muted-foreground shrink-0 text-sm">
        {classifierName}
      </span>
      <Select
        onValueChange={(next) =>
          onChange(next === null || next === SCOPE_ALL_VALUE ? null : next)
        }
        value={value ?? SCOPE_ALL_VALUE}
      >
        <SelectTrigger
          className="h-7 min-h-0 w-auto min-w-40 text-xs"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={SCOPE_ALL_VALUE}>{t("common.all")}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.value}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
};

type ManualTypeRowProps = {
  contentType: CreatableContentType;
  onContentTypeChange: (next: CreatableContentType) => void;
  typeChanged: boolean;
};

const ManualTypeRow = ({
  contentType,
  onContentTypeChange,
  typeChanged,
}: ManualTypeRowProps) => {
  const chipDefs = useChipDefinitions();
  return (
    <div className={cn(COMPOSER_CARD_CLASS, "gap-2")}>
      <TypeChipsRow
        chipDefs={chipDefs}
        contentType={contentType}
        onContentTypeChange={onContentTypeChange}
        typeChanged={typeChanged}
      />
    </div>
  );
};
