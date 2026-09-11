import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result, TaggedError } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { stellaToast } from "@stll/ui/toast";

import { openEntityFileFieldInInspector } from "@/components/chat/entity-open";
import { planInspectorGroupTransfer } from "@/components/inspector/inspector-group-transfer.logic";
import { getInspectorTabGroupId } from "@/components/inspector/inspector-groups.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { workspacesRouteOptions } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type PendingTransfer =
  | {
      groupId: string;
      tabId: string;
      workspaceId: string;
      type: "chat";
    }
  | {
      copiedFile: { entityId: string; fieldId: string | null } | null;
      groupId: string;
      tabId: string;
      workspaceId: string;
      type: "file";
    };

type InspectorGroupTransfer = {
  requestMove: (tabId: string, groupId: string | null) => void;
  dialog: ReactNode;
};

type ChatTransferAction = "add-context" | "group-only";

type TransferScope = {
  activeOrganizationId: string;
  userId: string;
};

class InspectorCopyMappingError extends TaggedError(
  "InspectorCopyMappingError",
)<{ message: string }> {}

export const useInspectorGroupTransfer = (
  returnFocus?: RefObject<HTMLElement | null>,
): InspectorGroupTransfer => {
  const t = useTranslations();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const [pending, setPending] = useState<PendingTransfer | null>(null);
  const { data } = useQuery({
    ...workspacesRouteOptions(activeOrganizationId),
    enabled: pending !== null,
  });
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const getActiveScope = useLatestCallback(() => ({
    activeOrganizationId,
    userId,
  }));
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrentScope = (scope: TransferScope): boolean => {
    if (!mountedRef.current) {
      return false;
    }
    const currentScope = getActiveScope();
    return (
      currentScope.activeOrganizationId === scope.activeOrganizationId &&
      currentScope.userId === scope.userId
    );
  };

  const requestMove = useCallback((tabId: string, groupId: string | null) => {
    const store = useInspectorTabsStore.getState();
    const tab = store.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) {
      return;
    }
    if (getInspectorTabGroupId(store, tab) === groupId) {
      return;
    }

    const plan = planInspectorGroupTransfer(tab, groupId);
    switch (plan.type) {
      case "assign":
        store.setTabGroup(tabId, groupId);
        return;
      case "confirm-chat-context":
        setPending({
          type: "chat",
          tabId,
          groupId: groupId ?? `matter:${plan.workspaceId}`,
          workspaceId: plan.workspaceId,
        });
        return;
      case "confirm-file-copy":
        setPending({
          type: "file",
          copiedFile: null,
          tabId,
          groupId: groupId ?? `matter:${plan.workspaceId}`,
          workspaceId: plan.workspaceId,
        });
        return;
      default:
        plan satisfies never;
        panic("Unhandled Inspector group transfer plan");
    }
  }, []);

  const close = () => {
    if (!submittingRef.current) {
      setPending(null);
    }
  };

  const assignPending = (action: ChatTransferAction) => {
    if (pending?.type !== "chat") {
      return;
    }
    const store = useInspectorTabsStore.getState();
    const tab = store.tabs.find((candidate) => candidate.id === pending.tabId);
    if (tab?.type !== "chat") {
      setPending(null);
      return;
    }
    if (
      action === "add-context" &&
      !tab.contextMatterIds.includes(pending.workspaceId)
    ) {
      store.setChatContext(tab.id, [
        ...tab.contextMatterIds,
        pending.workspaceId,
      ]);
    }
    store.setTabGroup(tab.id, pending.groupId);
    setPending(null);
  };

  const copyAndAssign = async () => {
    if (pending?.type !== "file" || submittingRef.current) {
      return;
    }
    const source = useInspectorTabsStore
      .getState()
      .tabs.find((candidate) => candidate.id === pending.tabId);
    if (source?.type !== "pdf") {
      setPending(null);
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    const requestScope = { activeOrganizationId, userId };
    let copiedFile = pending.copiedFile;
    if (copiedFile === null) {
      const result = await Result.tryPromise(async () => {
        const response = await api
          .entities({ workspaceId: toSafeId<"workspace">(source.workspaceId) })
          ["copy-to-workspace"].post({
            entityId: toSafeId<"entity">(source.entityId),
            targetWorkspaceId: toSafeId<"workspace">(pending.workspaceId),
            targetParentId: null,
            deleteSource: false,
            sourceFieldId: toSafeId<"field">(source.id),
          });
        return unwrapEden(response);
      });

      if (Result.isError(result)) {
        getAnalytics().captureError(result.error);
        submittingRef.current = false;
        if (isCurrentScope(requestScope)) {
          stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
          setIsSubmitting(false);
        }
        return;
      }

      const mappedField = result.value.field;
      copiedFile = {
        entityId: result.value.entityId,
        fieldId: mappedField?.fieldId ?? null,
      };
      if (!isCurrentScope(requestScope)) {
        submittingRef.current = false;
        if (mountedRef.current) {
          setIsSubmitting(false);
          setPending(null);
        }
        return;
      }
      setPending({ ...pending, copiedFile });
      if (mappedField === null) {
        getAnalytics().captureError(
          new InspectorCopyMappingError({
            message: "Copied Inspector file field was not returned",
          }),
        );
        stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
        submittingRef.current = false;
        setIsSubmitting(false);
        return;
      }
      const invalidation = await Result.tryPromise(
        async () =>
          await queryClient.invalidateQueries({
            queryKey: entitiesKeys.all(pending.workspaceId),
          }),
      );
      if (Result.isError(invalidation)) {
        getAnalytics().captureError(invalidation.error);
        submittingRef.current = false;
        if (isCurrentScope(requestScope)) {
          stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
          setIsSubmitting(false);
        }
        return;
      }
    }
    if (copiedFile.fieldId === null) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      submittingRef.current = false;
      setIsSubmitting(false);
      return;
    }
    const copiedEntityId = copiedFile.entityId;
    const copiedFieldId = copiedFile.fieldId;
    if (!isCurrentScope(requestScope)) {
      submittingRef.current = false;
      if (mountedRef.current) {
        setIsSubmitting(false);
        setPending(null);
      }
      return;
    }
    const openResult = await Result.tryPromise(async () => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(pending.workspaceId) })
        .entity({ entityId: toSafeId<"entity">(copiedEntityId) })
        .get();
      const copiedEntity = unwrapEden(response);
      if (!isCurrentScope(requestScope)) {
        return false;
      }
      return openEntityFileFieldInInspector({
        entityId: copiedEntityId,
        fieldId: copiedFieldId,
        fields: copiedEntity.fields,
        label: copiedEntity.name,
        workspaceId: pending.workspaceId,
      });
    });
    if (Result.isError(openResult)) {
      getAnalytics().captureError(openResult.error);
      submittingRef.current = false;
      if (isCurrentScope(requestScope)) {
        stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
        setIsSubmitting(false);
      }
      return;
    }
    if (!isCurrentScope(requestScope)) {
      submittingRef.current = false;
      if (mountedRef.current) {
        setIsSubmitting(false);
        setPending(null);
      }
      return;
    }
    const opened = openResult.value;
    const copiedTab = useInspectorTabsStore
      .getState()
      .tabs.find(
        (candidate) =>
          candidate.type === "pdf" && candidate.id === copiedFieldId,
      );
    if (!opened || copiedTab?.type !== "pdf") {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      submittingRef.current = false;
      setIsSubmitting(false);
      return;
    }

    useInspectorTabsStore.getState().setTabGroup(copiedTab.id, pending.groupId);
    submittingRef.current = false;
    setIsSubmitting(false);
    setPending(null);
  };

  const tab = useInspectorTabsStore((state) =>
    pending
      ? state.tabs.find((candidate) => candidate.id === pending.tabId)
      : undefined,
  );
  const matterName = pending
    ? (data?.workspaces.find(
        (workspace) => workspace.id === pending.workspaceId,
      )?.name ?? t("common.matter"))
    : "";
  const sourceMatterName =
    tab?.type === "pdf"
      ? (data?.workspaces.find((workspace) => workspace.id === tab.workspaceId)
          ?.name ?? t("common.matter"))
      : "";

  const dialog = (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open={pending !== null}
    >
      <DialogPopup className="max-w-lg" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>
            {pending?.type === "chat"
              ? t("inspector.groups.chatMoveTitle")
              : t("inspector.groups.fileMoveTitle")}
          </DialogTitle>
          <DialogDescription>
            {pending?.type === "chat"
              ? t.rich("inspector.groups.chatMoveDescription", {
                  chatName: tab?.label ?? "",
                  matterName,
                  bdi: (chunks) => <bdi>{chunks}</bdi>,
                })
              : t.rich("inspector.groups.fileMoveDescription", {
                  fileName: tab?.type === "pdf" ? tab.fileName : "",
                  matterName,
                  sourceMatterName,
                  bdi: (chunks) => <bdi>{chunks}</bdi>,
                })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button disabled={isSubmitting} onClick={close} variant="ghost">
            {t("common.cancel")}
          </Button>
          {pending?.type === "chat" ? (
            <>
              <Button
                onClick={() => assignPending("group-only")}
                variant="outline"
              >
                {t("inspector.groups.groupOnly")}
              </Button>
              <Button onClick={() => assignPending("add-context")}>
                {t("inspector.groups.addContext")}
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={isSubmitting}
                onClick={() => {
                  if (pending) {
                    useInspectorTabsStore
                      .getState()
                      .setTabGroup(pending.tabId, pending.groupId);
                    setPending(null);
                  }
                }}
                variant="outline"
              >
                {t("inspector.groups.groupOnly")}
              </Button>
              <Button
                disabled={isSubmitting}
                onClick={() => {
                  detached(copyAndAssign(), "inspector-group-transfer.copy");
                }}
              >
                {t("inspector.groups.copyIntoMatter")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  return { requestMove, dialog };
};
