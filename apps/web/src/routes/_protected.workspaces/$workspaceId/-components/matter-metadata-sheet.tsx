import { useState } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CopyIcon,
  CopyPlusIcon,
  EllipsisIcon,
  LockIcon,
  TrashIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { DestructiveConfirmDialog } from "@stella/ui/components/destructive-confirm-dialog";
import { Input } from "@stella/ui/components/input";
import { Separator } from "@stella/ui/components/separator";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stella/ui/components/sheet";
import { toastManager } from "@stella/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { APIError } from "@/lib/errors";
import { MembersSection } from "@/routes/_protected.workspaces/$workspaceId/-components/members-section";
import { PartiesSection } from "@/routes/_protected.workspaces/$workspaceId/-components/parties-section";
import {
  useDeleteWorkspace,
  useUpdateWorkspace,
} from "@/routes/_protected.workspaces/-mutations";
import {
  workspaceOptions,
  workspacesKeys,
} from "@/routes/_protected.workspaces/-queries";

const comingSoon = (label: string) => {
  toastManager.add({
    title: label,
    type: "foreground",
  });
};

type MatterMetadataSheetProps = {
  workspaceId: string;
};

export const MatterMetadataSheet = ({
  workspaceId,
}: MatterMetadataSheetProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [referenceValue, setReferenceValue] = useState("");
  const [referenceError, setReferenceError] = useState("");

  const { data: workspace } = useSuspenseQuery(workspaceOptions(workspaceId));
  const deleteWorkspace = useDeleteWorkspace();
  const canDeleteWorkspace = usePermissions({ workspace: ["delete"] });
  const updateWorkspace = useUpdateWorkspace();

  const handleSaveReference = () => {
    const trimmed = referenceValue.trim();
    if (!trimmed || trimmed === workspace.reference) {
      return;
    }

    setReferenceError("");

    updateWorkspace.mutate(
      {
        workspaceId,
        reference: trimmed,
      },
      {
        onSuccess: () => {
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspacesKeys.byId(workspaceId),
          });
        },
        onError: (error) => {
          if (APIError.is(error) && error.status === 409) {
            setReferenceError(t("workspaces.referenceTaken"));
            return;
          }

          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleDeleteWorkspace = async () => {
    if (deleteWorkspace.isPending) {
      return;
    }

    const toastId = toastManager.add({
      title: t("workspaces.deletingWorkspace"),
      type: "loading",
      timeout: Number.POSITIVE_INFINITY,
    });

    await deleteWorkspace.mutateAsync(
      { workspaceId },
      {
        onError: () => {
          toastManager.update(toastId, {
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
        // eslint-disable-next-line typescript/no-misused-promises
        onSuccess: async () => {
          toastManager.update(toastId, {
            title: t("success.workspaceDeletedSuccessfully"),
            type: "success",
          });
          await navigate({ to: "/workspaces" });
        },
      },
    );
  };

  return (
    <>
      <Sheet
        onOpenChange={(open) => {
          setIsOpen(open);
          if (open) {
            setReferenceValue(workspace.reference ?? "");
          }
        }}
        open={isOpen}
      >
        <SheetTrigger render={<Button size="icon-sm" variant="ghost" />}>
          <EllipsisIcon className="size-5" />
        </SheetTrigger>
        <SheetPopup side="right">
          <SheetHeader>
            <SheetTitle>{t("workspaces.matterInfo")}</SheetTitle>
            <SheetDescription />
          </SheetHeader>
          <SheetPanel className="flex flex-1 flex-col gap-4">
            {/* Reference */}
            <section className="px-4">
              <span className="text-muted-foreground mb-1.5 block text-sm font-medium">
                {t("workspaces.reference")}
              </span>
              <Input
                onBlur={handleSaveReference}
                onChange={(e) => {
                  setReferenceValue(e.target.value);
                  setReferenceError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
                placeholder={t("workspaces.referencePlaceholder")}
                value={referenceValue}
              />
              {referenceError && (
                <p className="text-destructive mt-1 text-xs">
                  {referenceError}
                </p>
              )}
            </section>

            <Separator />

            {/* Members */}
            <MembersSection workspaceId={workspaceId} />

            <Separator />

            {/* Parties */}
            <PartiesSection workspaceId={workspaceId} />

            <Separator />

            {/* Actions */}
            <div className="flex flex-col gap-0.5 px-2">
              <Button
                className="justify-start"
                onClick={() => comingSoon(t("common.comingSoon"))}
                size="sm"
                variant="ghost"
              >
                <CopyIcon className="size-4" />
                {t("common.duplicate")}
              </Button>
              <Button
                className="justify-start"
                onClick={() => comingSoon(t("common.comingSoon"))}
                size="sm"
                variant="ghost"
              >
                <CopyPlusIcon className="size-4" />
                {t("workspaces.duplicateWithContent")}
              </Button>
            </div>

            <Separator />

            {/* Status actions */}
            <div className="flex flex-col gap-0.5 px-2">
              <Button
                className="justify-start"
                onClick={() => comingSoon(t("common.comingSoon"))}
                size="sm"
                variant="ghost"
              >
                <LockIcon className="size-4" />
                {t("workspaces.lockMatter")}
              </Button>
              <Button
                className="justify-start"
                onClick={() => comingSoon(t("common.comingSoon"))}
                size="sm"
                variant="ghost"
              >
                <ArchiveIcon className="size-4" />
                {t("workspaces.archiveMatter")}
              </Button>
            </div>

            {/* Danger zone */}
            {canDeleteWorkspace && (
              <div className="mt-auto border-t px-2 pt-4">
                <Button
                  className="text-destructive justify-start"
                  disabled={deleteWorkspace.isPending}
                  onClick={() => setDeleteDialogOpen(true)}
                  size="sm"
                  variant="ghost"
                >
                  <TrashIcon className="size-4" />
                  {t("workspaces.deleteWorkspace")}
                </Button>
              </div>
            )}
          </SheetPanel>
        </SheetPopup>
      </Sheet>
      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        confirmation={workspace.name}
        description={t("workspaces.deleteWorkspaceConfirmDescription")}
        inputLabel={t("common.typeNameToConfirm")}
        loading={deleteWorkspace.isPending}
        onConfirm={handleDeleteWorkspace}
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        title={t("workspaces.deleteWorkspace")}
      />
    </>
  );
};
