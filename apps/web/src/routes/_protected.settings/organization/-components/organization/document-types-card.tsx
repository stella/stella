/**
 * Firm-wide document-type taxonomy editor. The list is the single source of
 * truth referenced by playbook scopes (via the stable `key`) and surfaced in
 * the workspace "Document Type" classifier. `key` is derived server-side on
 * create and never changes on rename, so existing playbook scopes never
 * orphan; deleting a type in use is blocked by the API and surfaced here.
 */

import { useState } from "react";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { preserveOffsetOnSource } from "@atlaskit/pragmatic-drag-and-drop/utils/preserve-offset-on-source";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/utils/set-custom-native-drag-preview";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import {
  useExternalSyncEffect,
  useKeyedState,
  useLatestCallback,
} from "@stll/ui/effects";
import { EntityActions, EntityActionsButton } from "@stll/ui/entity-actions";
import type { EntityAction } from "@stll/ui/entity-actions";
import { Form } from "@stll/ui/form";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileTextIcon,
  GripVerticalIcon,
  PlusIcon,
  Trash2Icon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";

import {
  withDragAnnouncementData,
  withDropAnnouncementData,
} from "@/components/drag-and-drop-live-region.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useSingleFlight } from "@/hooks/use-single-flight";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import {
  draggable,
  dropTargetForElements,
} from "@/lib/drag-and-drop/element-registration";
import { unwrapApiResponse } from "@/lib/errors/api";
import { documentTypesOptions, knowledgeKeys } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import { useSettingsMutation } from "@/routes/_protected.settings/organization/-hooks/use-settings-mutation";

import {
  DocumentTypeRowFace,
  DocumentTypeRows,
  DocumentTypesCardPending,
  DocumentTypesCardShell,
} from "./document-types-card.pending";

const DOCUMENT_TYPE_DRAG_TYPE = "stella/document-type";

type DocumentType = {
  id: SafeId<"documentType">;
  key: string;
  label: string;
  sortOrder: number;
};

// Shared across the settings list and the playbook editor's Type picker, so
// invalidating the factory's root refreshes wherever the taxonomy is shown.
const documentTypesInvalidationKey = knowledgeKeys.documentTypes.root;

export const DocumentTypesCard = () => {
  const t = useTranslations();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const settingsQuery = useQuery(documentTypesOptions(activeOrganizationId));
  const settingsView = queryView(settingsQuery, {
    isEmpty: (data) => data.items.length === 0,
  });
  const data = settingsView.type === "items" ? settingsView.items : undefined;
  const items = data ? data.items : [];

  const [newLabel, setNewLabel] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DocumentType | null>(null);
  // Created through a settings mutation, not a create hook: guard it here.
  const once = useSingleFlight();

  const createMutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "DocumentTypesCard.createMutation.useSettingsMutation",
    },
    mutationFn: async (label: string, request) =>
      unwrapApiResponse(await api["document-types"].post({ label }, request)),
    invalidate: documentTypesInvalidationKey,
    errorToast: {
      title: t("errors.actionFailed"),
      description: t("errors.actionFailed"),
    },
    onSuccess: () => setNewLabel(""),
  });

  const reorderMutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "DocumentTypesCard.reorderMutation.useSettingsMutation",
    },
    mutationFn: async (orderedIds: SafeId<"documentType">[]) =>
      unwrapApiResponse(
        await api["document-types"].reorder.post({ orderedIds }),
      ),
    invalidate: documentTypesInvalidationKey,
    invalidateOn: "settled",
    errorToast: { title: t("errors.actionFailed") },
  });

  const deleteMutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "DocumentTypesCard.deleteMutation.useSettingsMutation",
    },
    mutationFn: async (documentTypeId: SafeId<"documentType">) =>
      unwrapApiResponse(
        await api["document-types"]({ documentTypeId }).delete(),
      ),
    invalidate: documentTypesInvalidationKey,
    // Surfaces the API's "in use by N playbook(s)" guard message.
    errorToast: {
      title: t("settings.organization.documentTypes.deleteFailed"),
      description: t("errors.actionFailed"),
    },
    onSuccess: () => setDeleteTarget(null),
  });

  const handleReorder = (
    draggedId: SafeId<"documentType">,
    targetId: SafeId<"documentType">,
  ) => {
    if (draggedId === targetId) {
      return;
    }
    const ids = items.map((item) => item.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) {
      return;
    }
    reorderMutation.mutate(ids.toSpliced(from, 1).toSpliced(to, 0, draggedId));
  };

  const handleMove = (index: number, delta: -1 | 1) => {
    const current = items.at(index);
    const target = items.at(index + delta);
    if (!current || !target) {
      return;
    }
    handleReorder(current.id, target.id);
  };

  const submitNew = () => {
    const label = newLabel.trim();
    if (label.length === 0) {
      return;
    }
    detached(
      once.runSettled((settled) => {
        createMutation.mutate(label, { onSettled: settled });
      }),
      "document-types-card.create",
    );
  };

  if (settingsView.type === "pending") {
    return (
      <>
        <div className="sr-only">
          <QueryViewFeedback view={settingsView} />
        </div>
        <DocumentTypesCardPending />
      </>
    );
  }
  if (settingsView.type === "error") {
    return <QueryViewFeedback view={settingsView} />;
  }

  return (
    <DocumentTypesCardShell>
      <QueryViewFeedback view={settingsView} />
      {items.length > 0 ? (
        <DocumentTypeRows>
          {items.map((item, index) => (
            <DocumentTypeRow
              canMoveDown={index < items.length - 1}
              canMoveUp={index > 0}
              isReordering={reorderMutation.isPending}
              key={item.id}
              onMoveDown={() => handleMove(index, 1)}
              onMoveUp={() => handleMove(index, -1)}
              onReorder={handleReorder}
              onRequestDelete={() => setDeleteTarget(item)}
              type={item}
            />
          ))}
        </DocumentTypeRows>
      ) : (
        <div className="bg-muted/30 flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center">
          <FileTextIcon
            aria-hidden="true"
            className="text-muted-foreground size-8"
          />
          <p className="text-foreground text-sm font-medium">
            {t("settings.organization.documentTypes.empty")}
          </p>
          <p className="text-muted-foreground max-w-md text-xs">
            {t("settings.organization.documentTypes.description")}
          </p>
        </div>
      )}

      <Form
        density="compact"
        layout="inline"
        onSubmit={(event) => {
          event.preventDefault();
          submitNew();
        }}
      >
        <Input
          aria-label={t("settings.organization.documentTypes.addPlaceholder")}
          onChange={(event) => setNewLabel(event.target.value)}
          placeholder={t("settings.organization.documentTypes.addPlaceholder")}
          value={newLabel}
        />
        <Button
          disabled={newLabel.trim().length === 0 || createMutation.isPending}
          disabledReason={
            createMutation.isPending
              ? t("common.creating")
              : t("common.enterName")
          }
          type="submit"
        >
          <PlusIcon />
          {t("common.add")}
        </Button>
      </Form>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            setDeleteTarget(null);
          }
        }}
        open={deleteTarget !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("common.deleteConfirmDescription", {
                name: deleteTarget?.label ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={
                <Button
                  disabled={deleteMutation.isPending}
                  disabledReason={t("common.deleting")}
                  variant="ghost"
                />
              }
            >
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={deleteMutation.isPending}
              disabledReason={t("common.deleting")}
              loading={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget !== null) {
                  deleteMutation.mutate(deleteTarget.id);
                }
              }}
              variant="destructive"
            >
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </DocumentTypesCardShell>
  );
};

type DocumentTypeRowProps = {
  type: DocumentType;
  canMoveUp: boolean;
  canMoveDown: boolean;
  isReordering: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onReorder: (
    draggedId: SafeId<"documentType">,
    targetId: SafeId<"documentType">,
  ) => void;
  onRequestDelete: () => void;
};

const DocumentTypeRow = ({
  type,
  canMoveUp,
  canMoveDown,
  isReordering,
  onMoveUp,
  onMoveDown,
  onReorder,
  onRequestDelete,
}: DocumentTypeRowProps) => {
  const t = useTranslations();
  const [rowRef, setRowRef] = useState<HTMLLIElement | null>(null);
  const [gripRef, setGripRef] = useState<HTMLButtonElement | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  // The rename draft starts over when the label changes upstream (a refetch
  // after this or another client renames the type); `type.label` is stable
  // while the user types, so this never clobbers an in-progress edit.
  const [draft, setDraft] = useKeyedState(type.label, type.label);
  const handleReorder = useLatestCallback(onReorder);

  useExternalSyncEffect(() => {
    if (!rowRef || !gripRef) {
      return undefined;
    }
    return combine(
      draggable({
        element: rowRef,
        dragHandle: gripRef,
        getInitialData: () =>
          withDragAnnouncementData(
            { type: DOCUMENT_TYPE_DRAG_TYPE, id: type.id },
            type.label,
          ),
        onGenerateDragPreview: ({ location, nativeSetDragImage }) => {
          setCustomNativeDragPreview({
            nativeSetDragImage,
            getOffset: preserveOffsetOnSource({
              element: rowRef,
              input: location.current.input,
            }),
            render: ({ container }) => {
              const clone = rowRef.cloneNode(true);
              if (!(clone instanceof HTMLElement)) {
                return;
              }
              clone.style.width = `${rowRef.getBoundingClientRect().width}px`;
              container.append(clone);
            },
          });
        },
      }),
      dropTargetForElements({
        element: rowRef,
        canDrop: ({ source }) =>
          source.data["type"] === DOCUMENT_TYPE_DRAG_TYPE &&
          source.data["id"] !== type.id,
        getData: () =>
          withDropAnnouncementData({}, { type: "reorder", name: type.label }),
        onDragEnter: () => setIsDropTarget(true),
        onDragLeave: () => setIsDropTarget(false),
        onDrop: ({ source }) => {
          setIsDropTarget(false);
          const draggedId = source.data["id"];
          if (typeof draggedId === "string") {
            handleReorder(toSafeId<"documentType">(draggedId), type.id);
          }
        },
      }),
    );
  }, [rowRef, gripRef, type.id, type.label, handleReorder]);

  const renameMutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "DocumentTypeRow.renameMutation.useSettingsMutation",
    },
    mutationFn: async (label: string) =>
      unwrapApiResponse(
        await api["document-types"]({ documentTypeId: type.id }).patch({
          label,
        }),
      ),
    invalidate: documentTypesInvalidationKey,
    errorToast: {
      title: t("errors.actionFailed"),
      description: t("errors.actionFailed"),
    },
    onError: () => setDraft(type.label),
  });

  const commitRename = () => {
    const label = draft.trim();
    if (label.length === 0) {
      setDraft(type.label);
      return;
    }
    if (label === type.label) {
      return;
    }
    renameMutation.mutate(label);
  };

  const rowActions: readonly EntityAction[] = [
    {
      label: t("common.moveUp"),
      icon: <ArrowUpIcon className="size-3.5" />,
      disabled: !canMoveUp || isReordering,
      onClick: onMoveUp,
    },
    {
      label: t("common.moveDown"),
      icon: <ArrowDownIcon className="size-3.5" />,
      disabled: !canMoveDown || isReordering,
      onClick: onMoveDown,
    },
    {
      label: t("common.delete"),
      icon: <Trash2Icon className="size-3.5" />,
      variant: "destructive",
      separatorBefore: true,
      onClick: onRequestDelete,
    },
  ];

  return (
    <EntityActions
      actions={rowActions}
      label={t("common.actions")}
      render={<DocumentTypeRowFace dropTarget={isDropTarget} ref={setRowRef} />}
    >
      <Button
        aria-label={t("settings.organization.documentTypes.reorder")}
        className="shrink-0 cursor-grab"
        ref={setGripRef}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <GripVerticalIcon />
      </Button>
      <Input
        aria-label={t("settings.organization.documentTypes.labelAria")}
        className="h-8 flex-1 border-transparent bg-transparent shadow-none"
        onBlur={commitRename}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        value={draft}
      />
      <EntityActionsButton />
    </EntityActions>
  );
};
