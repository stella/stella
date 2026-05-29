import { Suspense, useCallback, useMemo, useRef, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { KeyboardIcon, PlusIcon, XIcon } from "lucide-react";
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
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import {
  COMPOSER_CARD_CLASS,
  ReadingFromRow,
  TypeChipsRow,
  useChipDefinitions,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/composer-primitives";
import type {
  CreatableContentType,
  FileChip,
  ManualChipOption,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/composer-primitives";
import { PropertyPromptInput } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import type { PropertyPromptFieldHandle } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import { usePropertiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import {
  useCreatePropertiesBatch,
  useSuggestPrompt,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import type { CreatePropertySpec } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

type DraftTool = "ai-model" | "manual-input";

type Draft = {
  id: number;
  name: string;
  prompt: string;
  mentions: string[];
  fileIds: string[];
  contentType: CreatableContentType;
  tool: DraftTool;
};

const makeEmptyDraft = (id: number, defaultFileIds: string[]): Draft => ({
  id,
  name: "",
  prompt: "",
  mentions: [],
  fileIds: defaultFileIds,
  contentType: "text",
  tool: "ai-model",
});

type TriggerVariant = "icon" | "labelled" | "rail" | "none";

type BulkAddColumnsProps = {
  workspaceId: string;
  triggerVariant?: TriggerVariant;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const BulkAddColumns = ({
  workspaceId,
  triggerVariant = "icon",
  open,
  onOpenChange,
}: BulkAddColumnsProps) => {
  const isLimitReached = usePropertiesCountLimit(workspaceId);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const dialogOpen = open ?? uncontrolledOpen;
  const setDialogOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (open === undefined) {
      setUncontrolledOpen(next);
    }
  };

  if (isLimitReached) {
    return null;
  }

  return (
    <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
      <BulkTrigger triggerVariant={triggerVariant} />
      <DialogPopup className="sm:max-w-[640px]">
        {dialogOpen && (
          <Suspense fallback={<BulkBodyFallback />}>
            <BulkBody
              onClose={() => setDialogOpen(false)}
              workspaceId={workspaceId}
            />
          </Suspense>
        )}
      </DialogPopup>
    </Dialog>
  );
};

type BulkTriggerProps = { triggerVariant: TriggerVariant };

const BulkTrigger = ({ triggerVariant }: BulkTriggerProps) => {
  const t = useTranslations();
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
  if (triggerVariant === "icon") {
    return (
      <DialogTrigger
        render={
          <button
            aria-label={t("workspaces.properties.newColumn")}
            className="ring-ring focus-visible:ring-offset-background text-muted-foreground flex h-full w-full cursor-pointer items-center justify-center border-0 bg-transparent p-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
            data-add-property-trigger
            data-row-expansion-ignore
            onClick={(event) => event.currentTarget.blur()}
            title={t("workspaces.properties.newColumn")}
            type="button"
          />
        }
      >
        <PlusIcon className="size-4" />
      </DialogTrigger>
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
            onClick={(event) => event.currentTarget.blur()}
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
};

const BulkBodyFallback = () => (
  <div className="space-y-3 p-5">
    <Skeleton className="h-5 w-24" />
    <Skeleton className="h-32 w-full" />
  </div>
);

type BulkBodyProps = {
  workspaceId: string;
  onClose: () => void;
};

const BulkBody = ({ workspaceId, onClose }: BulkBodyProps) => {
  const t = useTranslations();
  const batch = useCreatePropertiesBatch({ workspaceId });
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));

  const fileProperties = useMemo<FileChip[]>(
    () =>
      properties
        .filter((p) => p.content.type === "file")
        .map((p) => ({ id: p.id, name: p.name })),
    [properties],
  );
  const defaultFileIds = useMemo(
    () => fileProperties.map((p) => p.id),
    [fileProperties],
  );

  const [drafts, setDrafts] = useState<Draft[]>(() => [
    makeEmptyDraft(0, defaultFileIds),
  ]);
  const nextId = useNextId(drafts.length);

  const updateDraft = useCallback((id: number, patch: Partial<Draft>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );
  }, []);

  const removeDraft = useCallback((id: number) => {
    setDrafts((prev) =>
      prev.length === 1 ? prev : prev.filter((d) => d.id !== id),
    );
  }, []);

  const addDraft = useCallback(() => {
    setDrafts((prev) => [...prev, makeEmptyDraft(nextId(), defaultFileIds)]);
  }, [defaultFileIds, nextId]);

  const validDrafts = useMemo(
    () => drafts.filter((d) => d.name.trim().length > 0),
    [drafts],
  );
  const canSubmit = validDrafts.length > 0 && !batch.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }
    const items: CreatePropertySpec[] = validDrafts.map((d) => {
      if (d.tool === "manual-input") {
        return {
          name: d.name.trim(),
          contentType: d.contentType,
          toolType: "manual-input" as const,
        };
      }
      const dependencyIds = [...new Set([...d.fileIds, ...d.mentions])];
      const dependencies = dependencyIds.map((id) => ({
        dependsOnPropertyId: id,
        condition: null,
      }));
      return {
        name: d.name.trim(),
          contentType: d.contentType,
          toolType: "ai-model" as const,
          prompt: d.prompt,
        ...(dependencies.length > 0 ? { dependencies } : {}),
      };
    });
    try {
      await batch.mutateAsync({ items });
      stellaToast.add({
        title:
          items.length === 1
            ? t("workspaces.properties.bulk.createdOne")
            : t("workspaces.properties.bulk.createdMany", {
                count: String(items.length),
              }),
        type: "success",
      });
      onClose();
    } catch {
      stellaToast.add({
        title: t("workspaces.properties.bulk.createFailed"),
        type: "error",
      });
    }
  };

  return (
    <>
      <header className="flex items-center gap-2 px-5 pt-4 pb-3">
        <DialogTitle className="flex-1 text-base leading-tight font-semibold">
          {t("workspaces.properties.bulk.title")}
        </DialogTitle>
      </header>

      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 pt-1 pb-2">
        {drafts.map((draft) => (
          <DraftCard
            canRemove={drafts.length > 1}
            draft={draft}
            fileProperties={fileProperties}
            key={draft.id}
            onChange={(patch) => updateDraft(draft.id, patch)}
            onRemove={() => removeDraft(draft.id)}
            workspaceId={workspaceId}
          />
        ))}
        <Button
          className="text-foreground-label hover:text-foreground hover:bg-accent w-fit gap-1 px-2 font-normal"
          onClick={addDraft}
          size="xs"
          type="button"
          variant="ghost"
        >
          <PlusIcon className="size-3" />
          {t("workspaces.properties.bulk.addAnother")}
        </Button>
      </div>

      <div className="bg-muted/64 flex items-center justify-end gap-2 border-t px-5 py-3">
        <DialogClose render={<Button size="sm" variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={!canSubmit}
          loading={batch.isPending}
          onClick={() => {
            void handleSubmit();
          }}
          size="sm"
        >
          {t("workspaces.properties.bulk.title")}
        </Button>
      </div>
    </>
  );
};

const useNextId = (initial: number) => {
  const ref = useRef(initial);
  return useCallback(() => {
    ref.current += 1;
    return ref.current;
  }, []);
};

type DraftCardProps = {
  draft: Draft;
  canRemove: boolean;
  workspaceId: string;
  fileProperties: FileChip[];
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
};

const DraftCard = ({
  draft,
  canRemove,
  workspaceId,
  fileProperties,
  onChange,
  onRemove,
}: DraftCardProps) => {
  const t = useTranslations();
  const chipDefs = useChipDefinitions();
  const suggestPrompt = useSuggestPrompt();
  const editorRef = useRef<Editor | null>(null);

  const promptField: PropertyPromptFieldHandle = useMemo(
    () => ({
      name: `draft-${draft.id}`,
      state: { value: draft.prompt },
      handleChange: (next) => onChange({ prompt: next }),
      handleBlur: () => undefined,
    }),
    // The editor reads `state.value` only on init; subsequent updates
    // flow through `handleChange`, so a stable handle is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.id],
  );

  const handleMentions = useCallback(
    (mentions: string[]) => {
      onChange({ mentions });
    },
    [onChange],
  );

  const handleEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;
  }, []);

  const trimmedName = draft.name.trim();
  const isAi = draft.tool === "ai-model";
  const autoPromptDisabled =
    !isAi || trimmedName.length === 0 || suggestPrompt.isPending;

  const handleAutoPrompt = useCallback(() => {
    if (autoPromptDisabled) {
      return;
    }
    suggestPrompt.mutate(
      {
        workspaceId,
        name: trimmedName,
        contentType: draft.contentType,
      },
      {
        onSuccess: ({ prompt: suggested }) => {
          const editor = editorRef.current;
          if (!editor || editor.isDestroyed) {
            onChange({ prompt: suggested });
            return;
          }
          editor.commands.setContent(suggested);
          onChange({ prompt: editor.getHTML() });
        },
        onError: () => {
          stellaToast.add({
            title: t("workspaces.properties.autoPromptFailed"),
            type: "error",
          });
        },
      },
    );
  }, [
    autoPromptDisabled,
    draft.contentType,
    onChange,
    suggestPrompt,
    t,
    trimmedName,
    workspaceId,
  ]);

  const selectedFiles = useMemo(
    () =>
      draft.fileIds.flatMap((id) => {
        const found = fileProperties.find((p) => p.id === id);
        return found ? [found] : [];
      }),
    [draft.fileIds, fileProperties],
  );
  const availableFiles = fileProperties.filter(
    (p) => !draft.fileIds.includes(p.id),
  );

  const manualChip: ManualChipOption = {
    active: draft.tool === "manual-input",
    icon: KeyboardIcon,
    label: t("workspaces.properties.chipManual"),
    onClick: () => onChange({ tool: "manual-input" }),
  };

  return (
    <div className={COMPOSER_CARD_CLASS}>
      <div className="flex items-center gap-2">
        <Input
          autoComplete="off"
          autoFocus
          className="text-foreground placeholder:text-foreground-placeholder w-full px-0 text-[15px] font-semibold tracking-tight"
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t("workspaces.properties.newColumnName")}
          unstyled
          value={draft.name}
        />
        {canRemove && (
          <Button
            aria-label={t("workspaces.properties.bulk.removeRow")}
            className="text-foreground-placeholder hover:text-foreground ms-auto -me-1 size-6 shrink-0"
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>

      {isAi && (
        <>
          <ReadingFromRow
            fileChips={selectedFiles}
            onRemoveFile={(id) =>
              onChange({ fileIds: draft.fileIds.filter((f) => f !== id) })
            }
            {...(availableFiles.length > 0
              ? {
                  addFile: (id: string) =>
                    onChange({ fileIds: [...draft.fileIds, id] }),
                  availableFiles,
                }
              : {})}
          />

          <PropertyPromptInput
            aiEditAction={{
              disabled: autoPromptDisabled,
              isPending: suggestPrompt.isPending,
              label: t("workspaces.properties.suggestWithAI"),
              onClick: handleAutoPrompt,
            }}
            autoPopulateOnEmpty={false}
            field={promptField}
            onEditorReady={handleEditorReady}
            onMentionsChange={handleMentions}
            placeholder={t("workspaces.properties.extractionPlaceholder")}
            propertyId=""
            propertyName={draft.name}
            variant="minimal"
            workspaceId={workspaceId}
          />
        </>
      )}

      <TypeChipsRow
        chipDefs={chipDefs}
        contentType={draft.contentType}
        manualChip={manualChip}
        onContentTypeChange={(next) =>
          onChange({ contentType: next, tool: "ai-model" })
        }
        showSeparator
        typeChanged={false}
      />
    </div>
  );
};
