import { useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { openFilePicker } from "@stll/ui/file-picker";
import { SparklesIcon, UploadIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";

import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useEntitiesCountLimit } from "@/components/workspaces/hooks/use-limits";
import {
  MatterCombobox,
  toMatterOption,
} from "@/components/workspaces/matter-combobox";
import type { MatterOption } from "@/components/workspaces/matter-combobox";
import { WorkflowQueryFeedback } from "@/components/workspaces/workflow-query-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { useSingleFlight } from "@/hooks/use-single-flight";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  useCreateWorkspace,
  useDeleteWorkspace,
} from "@/lib/workspaces/mutations";
import { useCreateFileEntities } from "@/lib/workspaces/mutations/use-create-file-entities";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { useIsWorkflowRunning } from "@/lib/workspaces/queries/workspace";
import { workflowActionsDisabled } from "@/lib/workspaces/queries/workspace.logic";

type UploadDocumentDialogProps = {
  onClose: () => void;
  workspaceId?: string | undefined;
};

export const UploadDocumentDialog = ({
  onClose,
  workspaceId,
}: UploadDocumentDialogProps) => {
  const t = useTranslations();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  // The picked matter, or the one the caller opened the dialog for, resolved
  // from the same list the picker offers so both paths show the same name.
  const [picked, setPicked] = useState<MatterOption | null>(null);
  // A personal matter made here to hold the files until the organizer
  // suggests its name and client; the upload then opens it.
  const [draftMatterId, setDraftMatterId] = useState<string | null>(null);
  const createWorkspace = useCreateWorkspace();
  const draftOnce = useSingleFlight();
  const deleteWorkspace = useDeleteWorkspace();
  // Bumped when the dialog moves on, so a draft still being created is
  // deleted on arrival instead of selected.
  const draftRequest = useRef(0);
  // Leaving before any upload discards the still-empty draft. A failed delete
  // keeps it, so the user can retry rather than strand it.
  const discardDraft = async () => {
    draftRequest.current += 1;
    if (draftMatterId === null) {
      return true;
    }
    const result = await Result.tryPromise(
      async () =>
        await deleteWorkspace.mutateAsync({ workspaceId: draftMatterId }),
    );
    if (Result.isError(result)) {
      return false;
    }
    setDraftMatterId(null);
    return true;
  };
  const cancel = async () => {
    if (await discardDraft()) {
      onClose();
    }
  };
  const navigate = useNavigate();
  const createDraftMatter = async () => {
    draftRequest.current += 1;
    const request = draftRequest.current;
    const name = t("common.newMatter");
    const result = await Result.tryPromise(
      async () => await createWorkspace.mutateAsync({ name }),
    );
    if (Result.isError(result)) {
      notifyUserError(result.error, t("errors.actionFailed"));
      return;
    }
    if (request !== draftRequest.current) {
      deleteWorkspace.mutate({ workspaceId: result.value.id });
      return;
    }
    setDraftMatterId(result.value.id);
    setPicked({ clientName: null, color: null, id: result.value.id, name });
  };
  const mattersQuery = useQuery({
    ...workspacesNavigationOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
    select: (data) => data.workspaces.map(toMatterOption),
    enabled: workspaceId !== undefined,
  });
  const mattersView = queryView(mattersQuery);
  useQueryViewError(mattersView, "UploadDocumentDialog:query");
  const { refetch } = mattersQuery;
  const matters = mattersView.type === "items" ? mattersView.items : undefined;
  const selectedMatter =
    workspaceId === undefined
      ? picked
      : (matters?.find((matter) => matter.id === workspaceId) ?? null);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          detached(cancel(), "upload-document.cancel");
        }
      }}
      open
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspaces.kanban.uploadDocument")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {workspaceId ? (
            selectedMatter && (
              <p className="text-sm">
                <BidiText>{selectedMatter.name}</BidiText>
              </p>
            )
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="upload-matter">{t("common.selectAMatter")}</Label>
              <MatterCombobox
                activeOrganizationId={activeOrganizationId}
                userId={userId}
                id="upload-matter"
                onChange={(matter) => {
                  detached(
                    discardDraft().then((discarded) => {
                      if (discarded) {
                        setPicked(matter);
                      }
                      return;
                    }),
                    "upload-document.discard-draft",
                  );
                }}
                value={picked}
              />
              {draftMatterId === null && (
                <Button
                  className="self-start"
                  disabled={draftOnce.pending}
                  disabledReason={t("common.loading")}
                  onClick={() =>
                    detached(
                      draftOnce.run(createDraftMatter),
                      "upload-document.create-draft-matter",
                    )
                  }
                  size="sm"
                  variant="ghost"
                >
                  <SparklesIcon className="size-4" />
                  {t("workspaces.importOrganizer.newMatterFromDocuments")}
                </Button>
              )}
            </div>
          )}
          {workspaceId !== undefined && (
            <QueryViewFeedback view={mattersView} />
          )}
          {workspaceId !== undefined &&
            mattersQuery.status === "success" &&
            selectedMatter === null && (
              // The caller named a matter the navigation list does not carry —
              // a list that arrived without it. Reading it
              // again is the whole recovery, so offer that rather than leaving
              // the reader an upload they cannot start.
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-destructive">
                  {t("errors.actionFailed")}
                </span>
                <Button
                  onClick={() =>
                    detached(refetch(), "upload-document.retry-matters")
                  }
                  size="xs"
                  variant="ghost"
                >
                  {t("common.retry")}
                </Button>
              </div>
            )}
          {selectedMatter && (
            <QuerySuspenseBoundary
              area="command-palette-upload-document"
              errorFallback={({ reset }) => (
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-destructive">
                    {t("errors.actionFailed")}
                  </span>
                  <Button onClick={reset} size="xs" variant="ghost">
                    {t("common.retry")}
                  </Button>
                </div>
              )}
              suspenseFallback={
                <p className="text-muted-foreground text-sm">
                  {t("common.loading")}
                </p>
              }
              resetKeys={[selectedMatter.id]}
            >
              <UploadDocumentForMatter
                key={selectedMatter.id}
                onClose={() => {
                  onClose();
                  if (draftMatterId === selectedMatter.id) {
                    detached(
                      navigate({
                        to: "/workspaces/$workspaceId",
                        params: { workspaceId: draftMatterId },
                      }),
                      "upload-document.open-draft-matter",
                    );
                  }
                }}
                workspaceId={selectedMatter.id}
              />
            </QuerySuspenseBoundary>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            onClick={() => detached(cancel(), "upload-document.cancel")}
            variant="ghost"
          >
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type UploadDocumentForMatterProps = {
  onClose: () => void;
  workspaceId: string;
};

type UploadBlockedReasonOptions = {
  isUploadPending: boolean;
  workflowView: ReturnType<typeof useIsWorkflowRunning>;
  t: (
    key:
      | "workspaces.files.uploading"
      | "common.loading"
      | "common.loadFailed"
      | "workspaces.files.uploadBlockedByWorkflow",
  ) => string;
};

const uploadBlockedReason = ({
  isUploadPending,
  workflowView,
  t,
}: UploadBlockedReasonOptions) => {
  if (isUploadPending) {
    return t("workspaces.files.uploading");
  }
  switch (workflowView.type) {
    case "pending":
    case "empty":
      return t("common.loading");
    case "error":
      return t("common.loadFailed");
    case "items":
      return workflowView.refetchError === undefined
        ? t("workspaces.files.uploadBlockedByWorkflow")
        : t("common.loadFailed");
    default:
      workflowView satisfies never;
      return panic("Unhandled upload workflow view");
  }
};

const UploadDocumentForMatter = ({
  onClose,
  workspaceId,
}: UploadDocumentForMatterProps) => {
  const t = useTranslations();
  const [isUploadPending, createFileEntities] =
    useCreateFileEntities(workspaceId);
  const workflowView = useIsWorkflowRunning(workspaceId);
  const workflowDisabled = workflowActionsDisabled(workflowView);
  const isEntitiesLimitReached = useEntitiesCountLimit(workspaceId);
  const canCreateEntity = usePermissions({ entity: ["create"] });
  const disabled =
    !canCreateEntity ||
    isEntitiesLimitReached ||
    workflowDisabled ||
    isUploadPending;

  const uploadDisabledReason = uploadBlockedReason({
    isUploadPending,
    workflowView,
    t,
  });

  if (!canCreateEntity) {
    return (
      <p className="text-destructive text-sm">{t("errors.api.forbidden")}</p>
    );
  }
  if (isEntitiesLimitReached) {
    return (
      <p className="text-destructive text-sm">
        {t("workspaces.files.itemLimitReached")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <WorkflowQueryFeedback view={workflowView} />
      <Button
        className="min-h-11 border border-dashed"
        disabled={disabled}
        disabledReason={uploadDisabledReason}
        onClick={() =>
          openFilePicker({
            multiple: true,
            onPick: (files) => {
              createFileEntities({ files, parentId: null });
              onClose();
            },
          })
        }
        type="button"
        variant="outline"
      >
        <UploadIcon className="size-4" />
        {t("common.uploadFiles")}
      </Button>
    </div>
  );
};
