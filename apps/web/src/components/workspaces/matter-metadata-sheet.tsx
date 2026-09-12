import type { ReactNode } from "react";
import { useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { CopyIcon, CopyPlusIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { FieldDescription } from "@stll/ui/field";
import { Input } from "@stll/ui/input";
import { Separator } from "@stll/ui/separator";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { MatterNumberHint } from "@/components/matter-number-hint";
import { LeadSection } from "@/components/workspaces/lead-section";
import { MATTER_INFO_ICON_SLOT_CLASS } from "@/components/workspaces/matter-info-layout";
import { resolveReferenceEdit } from "@/components/workspaces/matter-metadata-sheet.logic";
import { MembersSection } from "@/components/workspaces/members-section";
import { PartiesSection } from "@/components/workspaces/parties-section";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  useDeleteWorkspace,
  useDuplicateWorkspace,
  useUpdateWorkspace,
} from "@/lib/workspaces/mutations";
import { workspaceOptions, workspacesKeys } from "@/lib/workspaces/queries";
import { useReferenceConflictMessage } from "@/lib/workspaces/use-reference-conflict-message";

type MatterMetadataPanelProps = {
  workspaceId: string;
  onDeleted?: () => void;
};

type DuplicateMode = "metadata" | "content";

type ReferenceConfirmation =
  | { status: "closed" }
  | { status: "confirming"; newReference: string };

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
  const [nameDirty, setNameDirty] = useState(false);
  const escapedNameRef = useRef(false);
  const [referenceValue, setReferenceValue] = useState("");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [referenceConfirmation, setReferenceConfirmation] =
    useState<ReferenceConfirmation>({ status: "closed" });
  const seededWorkspaceIdRef = useRef<string | null>(null);

  const workspaceQuery = useQuery(workspaceOptions(workspaceId));
  const workspace = workspaceQuery.data;
  const deleteWorkspace = useDeleteWorkspace();
  const duplicateWorkspace = useDuplicateWorkspace();
  const canCreateWorkspace = usePermissions({ workspace: ["create"] });
  const canDeleteWorkspace = usePermissions({ workspace: ["delete"] });
  const updateWorkspace = useUpdateWorkspace();
  const referenceConflictMessage = useReferenceConflictMessage();

  useExternalSyncEffect(() => {
    if (!workspace) {
      return;
    }
    if (seededWorkspaceIdRef.current !== workspaceId) {
      seededWorkspaceIdRef.current = workspaceId;
      escapedNameRef.current = false;
      setNameDirty(false);
      setReferenceDirty(false);
      setNameValue(workspace.name);
      setReferenceValue(workspace.reference);
      setReferenceError("");
      return;
    }

    if (!nameDirty) {
      setNameValue(workspace.name);
    }
    if (!referenceDirty) {
      setReferenceValue(workspace.reference);
      setReferenceError("");
    }
  }, [nameDirty, referenceDirty, workspace, workspaceId]);
  const handleSaveName = () => {
    if (!workspace) {
      return;
    }
    if (escapedNameRef.current) {
      escapedNameRef.current = false;
      setNameValue(workspace.name);
      setNameDirty(false);
      return;
    }

    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === workspace.name) {
      setNameValue(workspace.name);
      setNameDirty(false);
      return;
    }

    const fallbackName = workspace.name;
    updateWorkspace.mutate(
      {
        workspaceId,
        update: { type: "name", value: trimmed },
      },
      {
        onSuccess: () => {
          setNameDirty(false);
        },
        onError: (error) => {
          const message = userErrorFromThrown(error, t("errors.actionFailed"));
          stellaToast.add({ title: message, type: "error" });
          setNameValue(fallbackName);
          setNameDirty(false);
        },
      },
    );
  };

  const saveReference = (reference: string) => {
    setReferenceError("");

    updateWorkspace.mutate(
      {
        workspaceId,
        update: { type: "reference", value: reference },
      },
      {
        onSuccess: () => {
          setReferenceDirty(false);
          detached(
            queryClient.invalidateQueries({
              queryKey: workspacesKeys.byId(workspaceId),
            }),
            "matter-metadata-sheet.invalidate",
          );
        },
        onError: (error) => {
          const conflict = referenceConflictMessage(error, reference);
          if (conflict !== null) {
            setReferenceError(conflict);
            return;
          }

          const message = userErrorFromThrown(error, t("errors.actionFailed"));
          stellaToast.add({ title: message, type: "error" });
          setReferenceDirty(false);
        },
      },
    );
  };

  const revertReference = () => {
    if (!workspace) {
      return;
    }
    setReferenceValue(workspace.reference);
    setReferenceDirty(false);
    setReferenceError("");
  };

  const handleSaveReference = () => {
    if (!workspace) {
      return;
    }

    const edit = resolveReferenceEdit({
      currentReference: workspace.reference,
      nextReference: referenceValue,
      stampedVersionCount: workspace.stampedVersionCount,
    });

    switch (edit.type) {
      case "discard":
        revertReference();
        return;
      case "confirm":
        setReferenceError("");
        setReferenceConfirmation({
          status: "confirming",
          newReference: edit.reference,
        });
        return;
      case "save":
        saveReference(edit.reference);
        return;
      default:
        edit satisfies never;
        panic(`Unhandled reference edit: ${String(edit)}`);
    }
  };

  const cancelReferenceChange = () => {
    setReferenceConfirmation({ status: "closed" });
    revertReference();
  };

  const confirmReferenceChange = (newReference: string) => {
    setReferenceConfirmation({ status: "closed" });
    saveReference(newReference);
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
          detached(
            (async () => {
              stellaToast.update(toastId, {
                title: t("success.workspaceDeletedSuccessfully"),
                type: "success",
              });
              onDeleted?.();
              await navigate({ to: "/workspaces" });
            })(),
            "matter-metadata-sheet.update",
          );
        },
      },
    );
  };

  const handleDuplicateWorkspace = () => {
    if (
      !canCreateWorkspace ||
      duplicateMode === null ||
      duplicateWorkspace.isPending
    ) {
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
          detached(
            navigate({
              to: "/workspaces/$workspaceId",
              params: { workspaceId: data.workspaceId },
            }),
            "matter-metadata-sheet.navigate",
          );
        },
      },
    );
  };

  if (workspaceQuery.isError || !workspace) {
    return null;
  }

  // Document references are built from the matter reference, so the helper
  // spells out the numbering it produces. It reads the value being typed, not
  // the saved one, so the example tracks the edit before it is committed.
  // `bdi` isolates the Latin/digit runs inside an RTL sentence.
  const trimmedReference = referenceValue.trim();
  const documentNumberingHint =
    trimmedReference === ""
      ? t("workspaces.referenceNumberingEmptyHint")
      : t.rich("workspaces.referenceNumberingHint", {
          bdi: (chunks: ReactNode) => <BidiText>{chunks}</BidiText>,
          firstDocument: `${trimmedReference}/001`,
          secondDocument: `${trimmedReference}/002`,
        });

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
            onChange={(e) => {
              setNameDirty(true);
              setNameValue(e.target.value);
            }}
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
        <section className="grid shrink-0 grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 border-b px-3">
          <span className="text-muted-foreground truncate text-sm font-medium">
            {t("workspaces.reference")}
          </span>
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              TOOLBAR_ROW_HEIGHT,
            )}
          >
            <Input
              className="w-36 shrink-0 rounded-md shadow-none"
              // Held closed until the save settles: the mutation only resolves
              // after the matter refetch, so the field cannot blur again while
              // `workspace.reference` is still the pre-save value and re-open
              // the confirmation for an edit already on its way.
              disabled={updateWorkspace.isPending}
              onBlur={handleSaveReference}
              onChange={(e) => {
                setReferenceDirty(true);
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
          <FieldDescription className="col-start-2 pb-2 text-pretty">
            {documentNumberingHint}
          </FieldDescription>
        </section>

        {/* InfoSoud */}
        {/* Add with proper localization support for CS-only customers.
                The component is wired and works, but the surface (CZ court
                IDs, sp. zn. labels, etc.) is Czech-only by design — we hide it
                from the UX until we have a locale gate that only shows it to CS
                users or surfaces an EN explainer for non-CS users. */}
        {/* <InfoSoudSection active workspaceId={workspaceId} /> */}
        {/* <Separator /> */}

        {/* Lead */}
        <LeadSection workspaceId={workspaceId} />

        {/* Members */}
        <MembersSection workspaceId={workspaceId} />

        <Separator />

        {/* Parties */}
        <PartiesSection workspaceId={workspaceId} />

        <div className="mt-auto">
          {/* Actions */}
          {canCreateWorkspace && (
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
          )}

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
      {referenceConfirmation.status === "confirming" && (
        <AlertDialog
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              cancelReferenceChange();
            }
          }}
          open
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("workspaces.referenceChangeConfirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t.rich("workspaces.referenceChangeConfirmDescription", {
                  bdi: (chunks: ReactNode) => <BidiText>{chunks}</BidiText>,
                  count: workspace.stampedVersionCount,
                  newReference: referenceConfirmation.newReference,
                  oldReference: workspace.reference,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button onClick={cancelReferenceChange} variant="ghost">
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() =>
                  confirmReferenceChange(referenceConfirmation.newReference)
                }
              >
                {t("common.confirm")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
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
