import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import {
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { PlaybookBundleColumn, PropertyContent } from "@stll/api/types";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty } from "@/lib/types";
import {
  playbooksKeys,
  playbooksOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/playbooks";
import {
  propertiesKeys,
  propertiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

type PlaybooksManagerProps = {
  workspaceId: string;
};

type PlaybookColumnDraft = {
  sourceId: string;
  name: string;
  contentType: "text" | "date" | "int";
  prompt: string;
};

type PlaybookDraft = {
  id: string | null;
  name: string;
  typePropertyId: string;
  typeValue: string;
  columns: PlaybookColumnDraft[];
};

const DOCUMENT_TYPE_NAME = "Document Type";

const isDocumentTypeClassifier = (property: WorkspaceProperty): boolean =>
  property.content.type === "single-select" &&
  property.tool.type === "ai-model" &&
  property.name.trim().toLowerCase() === DOCUMENT_TYPE_NAME.toLowerCase();

const COLUMN_CONTENT_TYPES: PlaybookColumnDraft["contentType"][] = [
  "text",
  "date",
  "int",
];

const contentForColumn = (
  contentType: PlaybookColumnDraft["contentType"],
): PropertyContent => ({ version: 1, type: contentType });

const newColumnDraft = (): PlaybookColumnDraft => ({
  sourceId: crypto.randomUUID(),
  name: "",
  contentType: "text",
  prompt: "",
});

const columnContentTypeOf = (
  content: PropertyContent,
): PlaybookColumnDraft["contentType"] => {
  if (content.type === "date") {
    return "date";
  }
  if (content.type === "int") {
    return "int";
  }
  return "text";
};

export const PlaybooksManager = ({ workspaceId }: PlaybooksManagerProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const { data: properties } = useQuery(propertiesOptions(workspaceId));

  const classifier = properties?.find(isDocumentTypeClassifier);

  if (!classifier || classifier.content.type !== "single-select") {
    return null;
  }

  return (
    <>
      <Button
        className="text-muted-foreground hover:bg-accent gap-1 px-2 font-normal"
        onClick={() => setOpen(true)}
        size="xs"
        type="button"
        variant="ghost"
      >
        <WandSparklesIcon className="size-3" />
        {t("workspaces.playbooks.action")}
      </Button>
      {open && (
        <PlaybooksDialog
          classifierId={classifier.id}
          onOpenChange={setOpen}
          open={open}
          typeOptions={classifier.content.options.map((option) => option.value)}
          workspaceId={workspaceId}
        />
      )}
    </>
  );
};

type PlaybooksDialogProps = {
  workspaceId: string;
  classifierId: string;
  typeOptions: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const PlaybooksDialog = ({
  workspaceId,
  classifierId,
  typeOptions,
  open,
  onOpenChange,
}: PlaybooksDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { data: playbooks } = useQuery(playbooksOptions(workspaceId));
  const [draft, setDraft] = useState<PlaybookDraft | null>(null);
  const [pending, setPending] = useState(false);

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: playbooksKeys.all(workspaceId),
    });
  };

  const startCreate = () => {
    setDraft({
      id: null,
      name: "",
      typePropertyId: classifierId,
      typeValue: typeOptions[0] ?? "",
      columns: [newColumnDraft()],
    });
  };

  const handleSave = async () => {
    if (!draft) {
      return;
    }
    const columns = draft.columns
      .map((column) => ({ ...column, name: column.name.trim() }))
      .filter((column) => column.name.length > 0);

    if (draft.name.trim().length === 0 || columns.length === 0) {
      stellaToast.add({
        title: t("workspaces.playbooks.incomplete"),
        type: "error",
      });
      return;
    }

    if (new Set(columns.map((column) => column.name)).size !== columns.length) {
      stellaToast.add({
        title: t("workspaces.playbooks.duplicateColumn"),
        type: "error",
      });
      return;
    }

    const bundle: PlaybookBundleColumn[] = columns.map((column) => ({
      sourceId: column.sourceId,
      name: column.name,
      content: contentForColumn(column.contentType),
      prompt: column.prompt.trim(),
    }));

    const playbookApi = api.playbooks({
      workspaceId: toSafeId<"workspace">(workspaceId),
    });
    const body = {
      queryKey: playbooksKeys.all(workspaceId),
      name: draft.name.trim(),
      typePropertyId: toSafeId<"property">(draft.typePropertyId),
      typeValue: draft.typeValue,
      bundle,
    };

    setPending(true);
    const result = await Result.tryPromise(async () =>
      draft.id === null
        ? await playbookApi.put(body)
        : await playbookApi
            .playbook({ playbookId: toSafeId<"playbook">(draft.id) })
            .post(body),
    );

    if (Result.isError(result) || result.value.error) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      setPending(false);
      return;
    }

    await invalidate();
    setDraft(null);
    setPending(false);
  };

  const handleDelete = async (playbookId: string) => {
    setPending(true);
    const result = await Result.tryPromise(
      async () =>
        await api
          .playbooks({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .playbook({ playbookId: toSafeId<"playbook">(playbookId) })
          .delete({ queryKey: playbooksKeys.all(workspaceId) }),
    );

    if (Result.isError(result) || result.value.error) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      setPending(false);
      return;
    }

    await invalidate();
    setPending(false);
  };

  const handleApply = async (playbookId: string) => {
    setPending(true);
    const result = await Result.tryPromise(
      async () =>
        await api
          .playbooks({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .playbook({ playbookId: toSafeId<"playbook">(playbookId) })
          .apply.post({ queryKey: propertiesKeys.all(workspaceId) }),
    );

    if (Result.isError(result) || result.value.error) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      setPending(false);
      return;
    }

    await queryClient.invalidateQueries({
      queryKey: propertiesKeys.all(workspaceId),
    });
    stellaToast.add({
      title: t("workspaces.playbooks.applied"),
      type: "success",
    });
    setPending(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("workspaces.playbooks.title")}</DialogTitle>
          <DialogDescription>
            {t("workspaces.playbooks.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="pt-0">
          {draft ? (
            <PlaybookEditor
              draft={draft}
              onChange={setDraft}
              typeOptions={typeOptions}
            />
          ) : (
            <PlaybookList
              onApply={(playbookId) => void handleApply(playbookId)}
              onDelete={(playbookId) => void handleDelete(playbookId)}
              onEdit={(playbook) =>
                setDraft({
                  id: playbook.id,
                  name: playbook.name,
                  typePropertyId: playbook.typePropertyId,
                  typeValue: playbook.typeValue,
                  columns: playbook.bundle.map((column) => ({
                    sourceId: column.sourceId,
                    name: column.name,
                    contentType: columnContentTypeOf(column.content),
                    prompt: column.prompt,
                  })),
                })
              }
              pending={pending}
              playbooks={playbooks ?? []}
            />
          )}
        </DialogPanel>
        <DialogFooter>
          {draft ? (
            <>
              <Button
                onClick={() => setDraft(null)}
                type="button"
                variant="outline"
              >
                {t("common.cancel")}
              </Button>
              <Button
                loading={pending}
                onClick={() => void handleSave()}
                type="button"
              >
                {t("common.save")}
              </Button>
            </>
          ) : (
            <Button onClick={startCreate} type="button">
              <PlusIcon className="size-4" />
              {t("workspaces.playbooks.create")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type PlaybookListItem = {
  id: string;
  name: string;
  typePropertyId: string;
  typeValue: string;
  bundle: PlaybookBundleColumn[];
};

type PlaybookListProps = {
  playbooks: PlaybookListItem[];
  pending: boolean;
  onApply: (playbookId: string) => void;
  onDelete: (playbookId: string) => void;
  onEdit: (playbook: PlaybookListItem) => void;
};

const PlaybookList = ({
  playbooks,
  pending,
  onApply,
  onDelete,
  onEdit,
}: PlaybookListProps) => {
  const t = useTranslations();

  if (playbooks.length === 0) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        {t("workspaces.playbooks.empty")}
      </p>
    );
  }

  return (
    <ul className="divide-border divide-y rounded-md border">
      {playbooks.map((playbook) => (
        <li
          className="flex items-center gap-3 px-3 py-2 text-sm"
          key={playbook.id}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{playbook.name}</p>
            <p className="text-muted-foreground truncate text-xs">
              {t("workspaces.playbooks.summary", {
                type: playbook.typeValue,
                count: playbook.bundle.length,
              })}
            </p>
          </div>
          <Button
            disabled={pending}
            onClick={() => onApply(playbook.id)}
            size="xs"
            type="button"
            variant="outline"
          >
            <SparklesIcon className="size-3.5" />
            {t("workspaces.playbooks.apply")}
          </Button>
          <Button
            disabled={pending}
            onClick={() => onEdit(playbook)}
            size="xs"
            type="button"
            variant="ghost"
          >
            {t("common.edit")}
          </Button>
          <Button
            aria-label={t("common.delete")}
            disabled={pending}
            onClick={() => onDelete(playbook.id)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  );
};

type PlaybookEditorProps = {
  draft: PlaybookDraft;
  typeOptions: string[];
  onChange: (draft: PlaybookDraft) => void;
};

const PlaybookEditor = ({
  draft,
  typeOptions,
  onChange,
}: PlaybookEditorProps) => {
  const t = useTranslations();

  const updateColumn = (
    sourceId: string,
    updates: Partial<PlaybookColumnDraft>,
  ) => {
    onChange({
      ...draft,
      columns: draft.columns.map((column) =>
        column.sourceId === sourceId ? { ...column, ...updates } : column,
      ),
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="playbook-name">
          {t("workspaces.playbooks.nameLabel")}
        </Label>
        <Input
          id="playbook-name"
          onChange={(event) =>
            onChange({ ...draft, name: event.currentTarget.value })
          }
          placeholder={t("workspaces.playbooks.namePlaceholder")}
          value={draft.name}
        />
      </div>
      <div className="space-y-1.5">
        <Label>{t("workspaces.playbooks.typeLabel")}</Label>
        <Select
          items={typeOptions.map((value) => ({ label: value, value }))}
          onValueChange={(value) => {
            if (typeof value === "string") {
              onChange({ ...draft, typeValue: value });
            }
          }}
          value={draft.typeValue}
        >
          <SelectTrigger className="grid grid-cols-[1fr_auto]">
            <SelectValue className="truncate" />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {typeOptions.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("workspaces.playbooks.columnsLabel")}</Label>
          <Button
            onClick={() =>
              onChange({
                ...draft,
                columns: [...draft.columns, newColumnDraft()],
              })
            }
            size="xs"
            type="button"
            variant="outline"
          >
            <PlusIcon className="size-3.5" />
            {t("workspaces.playbooks.addColumn")}
          </Button>
        </div>
        <ul className="space-y-3">
          {draft.columns.map((column) => (
            <li
              className="space-y-2 rounded-md border p-3"
              key={column.sourceId}
            >
              <div className="flex items-center gap-2">
                <Input
                  onChange={(event) =>
                    updateColumn(column.sourceId, {
                      name: event.currentTarget.value,
                    })
                  }
                  placeholder={t("workspaces.playbooks.columnNamePlaceholder")}
                  value={column.name}
                />
                <Select
                  items={COLUMN_CONTENT_TYPES.map((value) => ({
                    label: t(`workspaces.playbooks.contentType.${value}`),
                    value,
                  }))}
                  onValueChange={(value) => {
                    if (
                      value === "text" ||
                      value === "date" ||
                      value === "int"
                    ) {
                      updateColumn(column.sourceId, { contentType: value });
                    }
                  }}
                  value={column.contentType}
                >
                  <SelectTrigger className="w-32 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {COLUMN_CONTENT_TYPES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`workspaces.playbooks.contentType.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  aria-label={t("common.delete")}
                  disabled={draft.columns.length === 1}
                  onClick={() =>
                    onChange({
                      ...draft,
                      columns: draft.columns.filter(
                        (current) => current.sourceId !== column.sourceId,
                      ),
                    })
                  }
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
              <Textarea
                className="min-h-16"
                onChange={(event) =>
                  updateColumn(column.sourceId, {
                    prompt: event.currentTarget.value,
                  })
                }
                placeholder={t("workspaces.playbooks.promptPlaceholder")}
                rows={2}
                value={column.prompt}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
