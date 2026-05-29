import { Suspense, useCallback, useMemo, useRef, useState } from "react";

import { PlusIcon, XIcon } from "lucide-react";
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
  TypeChipsRow,
  useChipDefinitions,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/composer-primitives";
import type { CreatableContentType } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/composer-primitives";
import { PropertyPromptInput } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import type { PropertyPromptFieldHandle } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/input";
import { usePropertiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import { useCreatePropertiesBatch } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import type { CreatePropertySpec } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";

type Draft = {
  id: number;
  name: string;
  prompt: string;
  mentions: string[];
  contentType: CreatableContentType;
};

const makeEmptyDraft = (id: number): Draft => ({
  id,
  name: "",
  prompt: "",
  mentions: [],
  contentType: "text",
});

const promptFromHtml = (html: string): string =>
  // eslint-disable-next-line sonarjs/slow-regex
  html.replace(/<[^>]+>/gu, "").trim();

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
  const [drafts, setDrafts] = useState<Draft[]>(() => [makeEmptyDraft(0)]);
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
    setDrafts((prev) => [...prev, makeEmptyDraft(nextId())]);
  }, [nextId]);

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
      const hasPrompt = promptFromHtml(d.prompt).length > 0;
      const dependencies = d.mentions.map((id) => ({
        dependsOnPropertyId: id,
        condition: null,
      }));
      return {
        name: d.name.trim(),
          contentType: d.contentType,
        ...(hasPrompt
          ? {
              toolType: "ai-model" as const,
              prompt: d.prompt,
              ...(dependencies.length > 0 ? { dependencies } : {}),
            }
          : { toolType: "manual-input" as const }),
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
        <DialogTitle className="flex-1 text-[15px] leading-none font-medium">
          {t("workspaces.properties.bulk.title")}
        </DialogTitle>
      </header>

      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 pt-1 pb-2">
        {drafts.map((draft) => (
          <DraftCard
            canRemove={drafts.length > 1}
            draft={draft}
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
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
};

const DraftCard = ({
  draft,
  canRemove,
  workspaceId,
  onChange,
  onRemove,
}: DraftCardProps) => {
  const t = useTranslations();
  const chipDefs = useChipDefinitions();

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

  return (
    <div className={COMPOSER_CARD_CLASS}>
      <div className="flex items-center gap-2">
        <Input
          autoComplete="off"
          autoFocus
          className="text-foreground placeholder:text-foreground-label border-0 bg-transparent text-sm font-medium shadow-none focus-visible:ring-0 focus-visible:outline-none"
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t("workspaces.properties.newColumnName")}
          value={draft.name}
        />
        {canRemove && (
          <Button
            aria-label={t("workspaces.properties.bulk.removeRow")}
            className="text-foreground-placeholder hover:text-foreground size-6"
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>

      <PropertyPromptInput
        autoPopulateOnEmpty={false}
        field={promptField}
        onMentionsChange={handleMentions}
        placeholder={t("workspaces.properties.extractionPlaceholder")}
        propertyId=""
        propertyName={draft.name}
        variant="minimal"
        workspaceId={workspaceId}
      />

      <TypeChipsRow
        chipDefs={chipDefs}
        contentType={draft.contentType}
        onContentTypeChange={(next) => onChange({ contentType: next })}
        showSeparator
        typeChanged={false}
      />
    </div>
  );
};
