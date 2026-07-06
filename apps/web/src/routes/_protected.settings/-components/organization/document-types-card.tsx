/**
 * Firm-wide document-type taxonomy editor. The list is the single source of
 * truth referenced by playbook scopes (via the stable `key`) and surfaced in
 * the workspace "Document Type" classifier. `key` is derived server-side on
 * create and never changes on rename, so existing playbook scopes never
 * orphan; deleting a type in use is blocked by the API and surfaced here.
 */

import { useEffectEvent, useState } from "react";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { preserveOffsetOnSource } from "@atlaskit/pragmatic-drag-and-drop/element/preserve-offset-on-source";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import { documentTypesOptions } from "@/routes/_protected.knowledge/-queries";

const DOCUMENT_TYPE_DRAG_TYPE = "stella/document-type";

type DocumentType = {
  id: SafeId<"documentType">;
  key: string;
  label: string;
  sortOrder: number;
};

// Shared across the settings list and the playbook editor's Type picker (both
// key their cache on `["document-types", ...]`), so a prefix invalidation
// refreshes wherever the taxonomy is shown.
const invalidateDocumentTypes = "document-types";

export const DocumentTypesCard = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data } = useQuery(documentTypesOptions(activeOrganizationId));
  const items = data?.items ?? [];

  const [newLabel, setNewLabel] = useState("");

  const createMutation = useMutation({
    mutationFn: async (label: string) => {
      const response = await api["document-types"].post({ label });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      setNewLabel("");
      await queryClient.invalidateQueries({
        queryKey: [invalidateDocumentTypes],
      });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        description: error instanceof Error ? error.message : undefined,
        type: "error",
      });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async (orderedIds: SafeId<"documentType">[]) => {
      const response = await api["document-types"].reorder.post({ orderedIds });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: [invalidateDocumentTypes],
      });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
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

  const submitNew = () => {
    const label = newLabel.trim();
    if (label.length === 0) {
      return;
    }
    createMutation.mutate(label);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-medium">
          {t("settings.organization.documentTypes.title")}
        </h3>
        <p className="text-muted-foreground text-sm">
          {t("settings.organization.documentTypes.description")}
        </p>
      </div>

      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <DocumentTypeRow
              key={item.id}
              onReorder={handleReorder}
              type={item}
            />
          ))}
        </ul>
      )}

      <form
        className="flex items-center gap-2"
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
          type="submit"
        >
          <PlusIcon />
          {t("common.add")}
        </Button>
      </form>
    </div>
  );
};

type DocumentTypeRowProps = {
  type: DocumentType;
  onReorder: (
    draggedId: SafeId<"documentType">,
    targetId: SafeId<"documentType">,
  ) => void;
};

const DocumentTypeRow = ({ type, onReorder }: DocumentTypeRowProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  const [rowRef, setRowRef] = useState<HTMLElement | null>(null);
  const [gripRef, setGripRef] = useState<HTMLButtonElement | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [draft, setDraft] = useState(type.label);
  const handleReorder = useEffectEvent(onReorder);

  // Resync the rename draft when the label changes upstream (a refetch after
  // this or another client renames the type); `type.label` is stable while the
  // user types, so this never clobbers an in-progress edit.
  useExternalSyncEffect(() => {
    setDraft(type.label);
  }, [type.label]);

  useExternalSyncEffect(() => {
    if (!rowRef || !gripRef) {
      return undefined;
    }
    return combine(
      draggable({
        element: rowRef,
        dragHandle: gripRef,
        getInitialData: () => ({ type: DOCUMENT_TYPE_DRAG_TYPE, id: type.id }),
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
  }, [rowRef, gripRef, type.id]);

  const renameMutation = useMutation({
    mutationFn: async (label: string) => {
      const response = await api["document-types"]({
        documentTypeId: type.id,
      }).patch({ label });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [invalidateDocumentTypes],
      });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      setDraft(type.label);
      stellaToast.add({
        title: t("errors.actionFailed"),
        description: error instanceof Error ? error.message : undefined,
        type: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await api["document-types"]({
        documentTypeId: type.id,
      }).delete();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [invalidateDocumentTypes],
      });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      // Surfaces the API's "in use by N playbook(s)" guard message.
      stellaToast.add({
        title: t("settings.organization.documentTypes.deleteFailed"),
        description: error instanceof Error ? error.message : undefined,
        type: "error",
      });
    },
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

  return (
    <li
      className={cn(
        "bg-card flex items-center gap-2 rounded-lg border px-2 py-1.5",
        isDropTarget && "ring-primary ring-2",
      )}
      ref={setRowRef}
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
      <span className="text-muted-foreground shrink-0 font-mono text-xs">
        {type.key}
      </span>
      <Button
        aria-label={t("common.delete")}
        className="shrink-0"
        disabled={deleteMutation.isPending}
        onClick={() => deleteMutation.mutate()}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <Trash2Icon />
      </Button>
    </li>
  );
};
