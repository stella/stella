import { useEffect, useRef, useState } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon, CopyPlusIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { Separator } from "@stll/ui/components/separator";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { MatterNumberHint } from "@/components/matter-number-hint";
import { usePermissions } from "@/hooks/use-permissions";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { APIError } from "@/lib/errors";
import { MATTER_INFO_ICON_SLOT_CLASS } from "@/routes/_protected.workspaces/$workspaceId/-components/matter-info-layout";
import { MembersSection } from "@/routes/_protected.workspaces/$workspaceId/-components/members-section";
import { PartiesSection } from "@/routes/_protected.workspaces/$workspaceId/-components/parties-section";
import {
  useDeleteWorkspace,
  useDuplicateWorkspace,
  useUpdateWorkspace,
} from "@/routes/_protected.workspaces/-mutations";
import {
  workspaceOptions,
  workspacesKeys,
} from "@/routes/_protected.workspaces/-queries";

type MatterMetadataPanelProps = {
  workspaceId: string;
  onDeleted?: () => void;
};

type DuplicateMode = "metadata" | "content";

export const MatterMetadataPanel = ({
  workspaceId,
  onDeleted,
}: MatterMetadataPanelProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode | null>(
    null,
  );
  const [nameValue, setNameValue] = useState("");
  const escapedNameRef = useRef(false);
  const [referenceValue, setReferenceValue] = useState("");
  const [referenceError, setReferenceError] = useState("");

  const { data: workspace } = useSuspenseQuery(workspaceOptions(workspaceId));
  const deleteWorkspace = useDeleteWorkspace();
  const duplicateWorkspace = useDuplicateWorkspace();
  const canDeleteWorkspace = usePermissions({ workspace: ["delete"] });
  const updateWorkspace = useUpdateWorkspace();

  useEffect(() => {
    escapedNameRef.current = false;
    setNameValue(workspace.name);
    setReferenceValue(workspace.reference ?? "");
    setReferenceError("");
  }, [workspace.name, workspace.reference]);

  const handleSaveName = () => {
    if (escapedNameRef.current) {
      escapedNameRef.current = false;
      setNameValue(workspace.name);
      return;
    }

    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === workspace.name) {
      setNameValue(workspace.name);
      return;
    }

    updateWorkspace.mutate(
      {
        workspaceId,
        name: trimmed,
      },
      {
        onError: (error) => {
          const message =
            APIError.is(error) && error.status < 500
              ? error.message
              : t("errors.actionFailed");
          stellaToast.add({ title: message, type: "error" });
          setNameValue(workspace.name);
        },
      },
    );
  };

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

          const message =
            APIError.is(error) && error.status < 500
              ? error.message
              : t("errors.actionFailed");
          stellaToast.add({ title: message, type: "error" });
        },
      },
    );
  };

  const handleDeleteWorkspace = async () => {
    if (deleteWorkspace.isPending) {
      return;
    }

    const toastId = stellaToast.add({
      title: t("workspaces.deletingWorkspace"),
      type: "loading",
      timeout: Number.POSITIVE_INFINITY,
    });

    await deleteWorkspace.mutateAsync(
      { workspaceId },
      {
        onError: () => {
          stellaToast.update(toastId, {
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
        onSuccess: () => {
          void (async () => {
            stellaToast.update(toastId, {
              title: t("success.workspaceDeletedSuccessfully"),
              type: "success",
            });
            onDeleted?.();
            await navigate({ to: "/workspaces" });
          })();
        },
      },
    );
  };

  const handleDuplicateWorkspace = () => {
    if (duplicateMode === null || duplicateWorkspace.isPending) {
      return;
    }

    const toastId = stellaToast.add({
      title: t("workspaces.duplicatingWorkspace"),
      type: "loading",
      timeout: Number.POSITIVE_INFINITY,
    });

    duplicateWorkspace.mutate(
      {
        workspaceId,
        includeContent: duplicateMode === "content",
      },
      {
        onError: () => {
          stellaToast.update(toastId, {
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
        onSuccess: (data) => {
          stellaToast.update(toastId, {
            title: t("success.workspaceDuplicatedSuccessfully"),
            type: "success",
          });
          setDuplicateMode(null);
          void navigate({
            to: "/workspaces/$workspaceId",
            params: { workspaceId: data.workspaceId },
          });
        },
      },
    );
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Name */}
        <section
          className={cn(
            "grid shrink-0 grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 border-b px-3",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <span className="text-muted-foreground truncate text-sm font-medium">
            {t("common.name")}
          </span>
          <Input
            className="rounded-md shadow-none"
            disabled={updateWorkspace.isPending}
            onBlur={handleSaveName}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                escapedNameRef.current = true;
                e.currentTarget.blur();
              }
            }}
            size="sm"
            value={nameValue}
          />
        </section>

        {/* Reference */}
        <section
          className={cn(
            "grid shrink-0 grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 border-b px-3",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <span className="text-muted-foreground truncate text-sm font-medium">
            {t("workspaces.reference")}
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              className="w-36 shrink-0 rounded-md shadow-none"
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
              size="sm"
              value={referenceValue}
            />
            <MatterNumberHint
              className="mt-0 min-w-0 flex-1"
              error={referenceError}
              value={referenceValue}
              variant="inline"
            />
          </div>
        </section>

        {/* InfoSoud */}
        {/* TODO: add with proper localization support for CS-only
                customers. The component is wired and works, but the
                surface (CZ court IDs, sp. zn. labels, etc.) is
                Czech-only by design — we hide it from the UX until
                we have a locale gate that only shows it to CS users
                or surfaces an EN explainer for non-CS users. */}
        {/* <InfoSoudSection active workspaceId={workspaceId} /> */}
        {/* <Separator /> */}

        {/* Members */}
        <MembersSection workspaceId={workspaceId} />

        <Separator />

        {/* Parties */}
        <PartiesSection workspaceId={workspaceId} />

        <div className="mt-auto">
          {/* Actions */}
          <div className="flex flex-col">
            <Button
              className={cn(
                "w-full justify-start rounded-none px-3",
                TOOLBAR_ROW_HEIGHT,
              )}
              onClick={() => setDuplicateMode("metadata")}
              variant="ghost"
            >
              <span className={MATTER_INFO_ICON_SLOT_CLASS}>
                <CopyIcon className="size-4" />
              </span>
              {t("common.duplicate")}
            </Button>
            <Button
              className={cn(
                "w-full justify-start rounded-none px-3",
                TOOLBAR_ROW_HEIGHT,
              )}
              onClick={() => setDuplicateMode("content")}
              variant="ghost"
            >
              <span className={MATTER_INFO_ICON_SLOT_CLASS}>
                <CopyPlusIcon className="size-4" />
              </span>
              {t("workspaces.duplicateWithContent")}
            </Button>
          </div>

          {/* Danger zone */}
          {canDeleteWorkspace && (
            <button
              className={cn(
                "text-destructive hover:bg-accent flex w-full shrink-0 items-center gap-2 border-t px-3 text-sm font-medium transition-colors",
                TOOLBAR_ROW_HEIGHT,
              )}
              disabled={deleteWorkspace.isPending}
              onClick={() => setDeleteDialogOpen(true)}
              type="button"
            >
              <span className={MATTER_INFO_ICON_SLOT_CLASS}>
                <TrashIcon className="size-4" />
              </span>
              {t("workspaces.deleteWorkspace")}
            </button>
          )}
        </div>
      </div>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setDuplicateMode(null);
          }
        }}
        open={duplicateMode !== null}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("workspaces.duplicateMatter")}</DialogTitle>
            <DialogDescription>
              {duplicateMode === "content"
                ? t("workspaces.duplicateMatterWithContentDescription")
                : t("workspaces.duplicateMatterDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              loading={duplicateWorkspace.isPending}
              onClick={handleDuplicateWorkspace}
            >
              {t("common.duplicate")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
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
