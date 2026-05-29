import { useCallback, useMemo, useRef, useState } from "react";

import {
  AlignLeftIcon,
  CalendarIcon,
  CircleDotIcon,
  HashIcon,
  PlusIcon,
  TagsIcon,
  Trash2Icon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { usePropertiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import { useCreatePropertiesBatch } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import type { CreatePropertySpec } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";

type DraftType = "text" | "single-select" | "multi-select" | "date" | "int";

type Draft = {
  id: number;
  name: string;
  prompt: string;
  contentType: DraftType;
};

type TypeChip = {
  type: DraftType;
  icon: LucideIcon;
  label: string;
};

const useTypeChips = (): readonly TypeChip[] => {
  const t = useTranslations();
  return [
    {
      type: "text",
      icon: AlignLeftIcon,
      label: t("workspaces.properties.chipText"),
    },
    {
      type: "int",
      icon: HashIcon,
      label: t("workspaces.properties.chipNumber"),
    },
    {
      type: "date",
      icon: CalendarIcon,
      label: t("workspaces.properties.chipDate"),
    },
    {
      type: "single-select",
      icon: CircleDotIcon,
      label: t("workspaces.properties.chipSingle"),
    },
    {
      type: "multi-select",
      icon: TagsIcon,
      label: t("workspaces.properties.chipMulti"),
    },
  ];
};

const makeEmptyDraft = (id: number): Draft => ({
  id,
  name: "",
  prompt: "",
  contentType: "text",
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
      <DialogPopup className="sm:max-w-[680px]">
        {dialogOpen && (
          <BulkBody
            onClose={() => setDialogOpen(false)}
            workspaceId={workspaceId}
          />
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

type BulkBodyProps = {
  workspaceId: string;
  onClose: () => void;
};

const BulkBody = ({ workspaceId, onClose }: BulkBodyProps) => {
  const t = useTranslations();
  const batch = useCreatePropertiesBatch({ workspaceId });
  const [drafts, setDrafts] = useState<Draft[]>(() => [makeEmptyDraft(0)]);
  const nextIdRef = useNextIdRef(drafts.length);

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
    setDrafts((prev) => [...prev, makeEmptyDraft(nextIdRef())]);
  }, [nextIdRef]);

  const validDrafts = useMemo(
    () => drafts.filter((d) => d.name.trim().length > 0),
    [drafts],
  );
  const canSubmit = validDrafts.length > 0 && !batch.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }
    const items: CreatePropertySpec[] = validDrafts.map((d) => ({
      name: d.name.trim(),
      contentType: d.contentType,
      ...(d.prompt.trim().length > 0
        ? { toolType: "ai-model" as const, prompt: d.prompt.trim() }
        : { toolType: "manual-input" as const }),
    }));
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
        <h2 className="flex-1 text-[15px] leading-none font-medium">
          {t("workspaces.properties.bulk.title")}
        </h2>
      </header>

      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 pt-1 pb-2">
        {drafts.map((draft, index) => (
          <DraftRow
            canRemove={drafts.length > 1}
            draft={draft}
            index={index}
            key={draft.id}
            onChange={(patch) => updateDraft(draft.id, patch)}
            onRemove={() => removeDraft(draft.id)}
          />
        ))}
        <Button
          className="text-muted-foreground hover:text-foreground hover:bg-accent w-fit gap-1 px-2 font-normal"
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
          {validDrafts.length <= 1
            ? t("workspaces.properties.bulk.createOne")
            : t("workspaces.properties.bulk.createMany", {
                count: String(validDrafts.length),
              })}
        </Button>
      </div>
    </>
  );
};

const useNextIdRef = (initial: number) => {
  const ref = useRef(initial);
  return useCallback(() => {
    ref.current += 1;
    return ref.current;
  }, []);
};

type DraftRowProps = {
  draft: Draft;
  index: number;
  canRemove: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
};

const DraftRow = ({
  draft,
  index,
  canRemove,
  onChange,
  onRemove,
}: DraftRowProps) => {
  const t = useTranslations();
  const chips = useTypeChips();

  return (
    <div className="bg-muted/24 flex flex-col gap-2 rounded-[9px] border p-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-5 text-center text-xs tabular-nums">
          {index + 1}
        </span>
        <Input
          autoComplete="off"
          autoFocus={index === 0}
          className="text-foreground placeholder:text-foreground-label flex-1 border-0 bg-transparent text-sm font-medium shadow-none focus-visible:ring-0 focus-visible:outline-none"
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t("workspaces.properties.newColumnName")}
          value={draft.name}
        />
        {canRemove && (
          <Button
            aria-label={t("workspaces.properties.bulk.removeRow")}
            className="text-muted-foreground hover:text-foreground size-7"
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        )}
      </div>

      <Textarea
        className="min-h-[60px] resize-none text-sm"
        onChange={(e) => onChange({ prompt: e.target.value })}
        placeholder={t("workspaces.properties.bulk.promptPlaceholder")}
        value={draft.prompt}
      />

      <div className="flex flex-wrap gap-1.5">
        {chips.map(({ type, icon: Icon, label }) => {
          const active = draft.contentType === type;
          return (
            <button
              className={cn(
                "border-border ring-ring focus-visible:ring-offset-background inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
                active
                  ? "bg-foreground text-background border-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground bg-transparent",
              )}
              key={type}
              onClick={() => onChange({ contentType: type })}
              type="button"
            >
              <Icon className="size-3" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
