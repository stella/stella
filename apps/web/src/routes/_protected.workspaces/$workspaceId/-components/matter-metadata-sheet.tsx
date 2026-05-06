import { useRef, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import { Input } from "@stll/ui/components/input";
import { Separator } from "@stll/ui/components/separator";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stll/ui/components/sheet";
import { stellaToast } from "@stll/ui/components/toast";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CopyIcon,
  CopyPlusIcon,
  EllipsisIcon,
  LockIcon,
  TrashIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { MatterNumberHint } from "@/components/matter-number-hint";
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
  stellaToast.add({
    title: label,
    type: "neutral",
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
  const [nameValue, setNameValue] = useState("");
  const escapedNameRef = useRef(false);
  const [referenceValue, setReferenceValue] = useState("");
  const [referenceError, setReferenceError] = useState("");

  const { data: workspace } = useSuspenseQuery(workspaceOptions(workspaceId));
  const deleteWorkspace = useDeleteWorkspace();
  const canDeleteWorkspace = usePermissions({ workspace: ["delete"] });
  const updateWorkspace = useUpdateWorkspace();

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
        // eslint-disable-next-line typescript/no-misused-promises
        onSuccess: () => {
          void (async () => {
            stellaToast.update(toastId, {
              title: t("success.workspaceDeletedSuccessfully"),
              type: "success",
            });
            await navigate({ to: "/workspaces" });
          })();
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
            escapedNameRef.current = false;
            setNameValue(workspace.name);
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
            {/* Name */}
            <section className="px-4">
              <span className="text-muted-foreground mb-1.5 block text-sm font-medium">
                {t("common.name")}
              </span>
              <Input
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
                value={nameValue}
              />
            </section>

            <Separator />

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
              <MatterNumberHint
                error={referenceError}
                value={referenceValue}
                variant="inline"
              />
            </section>

            <Separator />

            {/* InfoSoud */}
            {/* TODO: add with proper localization support for CS-only
                customers. The component is wired and works, but the
                surface (CZ court IDs, sp. zn. labels, etc.) is
                Czech-only by design — we hide it from the UX until
                we have a locale gate that only shows it to CS users
                or surfaces an EN explainer for non-CS users. */}
            {/* <InfoSoudSection active={isOpen} workspaceId={workspaceId} /> */}
            {/* <Separator /> */}

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
