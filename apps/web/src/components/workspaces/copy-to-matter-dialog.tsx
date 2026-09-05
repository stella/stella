import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Label } from "@stll/ui/label";
import { stellaToast } from "@stll/ui/toast";

import {
  MatterTargetPicker,
  useResolveMatterTarget,
} from "@/components/matter-target-picker";
import type { MatterTarget } from "@/components/matter-target-picker.logic";
import {
  getCopyToMatterRootEntities,
  type CopyToMatterEntity,
} from "@/components/workspaces/copy-to-matter-dialog.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type CopyToMatterDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceWorkspaceId: string;
  entities: CopyToMatterEntity[];
  /** Preselects a target matter (e.g. when opened from a drag-onto-matter
   *  drop in the sidebar). The user can still change it inside the dialog. */
  initialTargetWorkspaceId?: string | null;
};

type MoveMode = "copy" | "move";

export const CopyToMatterDialog = ({
  open,
  onOpenChange,
  sourceWorkspaceId,
  entities,
  initialTargetWorkspaceId,
}: CopyToMatterDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<MoveMode>("copy");
  const [target, setTarget] = useState<MatterTarget | null>(
    initialTargetWorkspaceId
      ? {
          type: "existing",
          workspaceId: initialTargetWorkspaceId,
          parentId: null,
        }
      : null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const resolveTarget = useResolveMatterTarget();

  // The dialog is mounted once and reused across drops, so re-seed the target
  // matter each time it opens with a fresh preset (drag-onto-matter path).
  useExternalSyncEffect(() => {
    if (open) {
      setTarget(
        initialTargetWorkspaceId
          ? {
              type: "existing",
              workspaceId: initialTargetWorkspaceId,
              parentId: null,
            }
          : null,
      );
    }
  }, [open, initialTargetWorkspaceId]);

  const transferEntities = getCopyToMatterRootEntities(entities);
  const singleEntity =
    transferEntities.length === 1 ? transferEntities.at(0) : undefined;

  const handleSubmit = async () => {
    if (!target) {
      return;
    }

    setIsSubmitting(true);

    const resolved = await resolveTarget(target);
    if (Result.isError(resolved)) {
      setIsSubmitting(false);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    const { workspaceId: targetWorkspaceId, parentId: targetParentId } =
      resolved.value;
    if (target.type === "pending") {
      // A staged folder now exists; keep it so a retry after a failed transfer
      // does not create a second one.
      setTarget({
        type: "existing",
        workspaceId: targetWorkspaceId,
        parentId: targetParentId,
      });
    }

    let failedCount = 0;
    let firstErrorMessage: string | null = null;
    for (const { entityId } of transferEntities) {
      const result = await Result.tryPromise(async () => {
        const { data, error } = await api
          .entities({ workspaceId: toSafeId<"workspace">(sourceWorkspaceId) })
          ["copy-to-workspace"].post({
            entityId: toSafeId<"entity">(entityId),
            targetWorkspaceId: toSafeId<"workspace">(targetWorkspaceId),
            targetParentId: targetParentId
              ? toSafeId<"entity">(targetParentId)
              : null,
            deleteSource: mode === "move",
          });
        return { data, error };
      });

      if (Result.isError(result)) {
        failedCount++;
        continue;
      }
      const { error } = result.value;
      if (error) {
        failedCount++;
        if (
          firstErrorMessage === null &&
          typeof error.value === "object" &&
          "message" in error.value
        ) {
          firstErrorMessage = error.value.message;
        }
      }
    }

    // Invalidate both workspaces even on partial failure; some
    // entities may have transferred before the failing one.
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(sourceWorkspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(targetWorkspaceId),
      }),
    ]);

    setIsSubmitting(false);

    if (failedCount === transferEntities.length) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        description: firstErrorMessage ?? undefined,
        type: "error",
      });
      return;
    }

    const successTitle =
      mode === "copy"
        ? t("workspaces.copyToMatter.copied")
        : t("workspaces.copyToMatter.moved");
    const goToMatterAction = {
      label: t("workspaces.copyToMatter.goToMatter"),
      onClick: () => {
        detached(
          navigate({
            to: "/workspaces/$workspaceId",
            params: { workspaceId: targetWorkspaceId },
          }),
          "copy-to-matter-dialog.navigate",
        );
      },
    };
    if (failedCount > 0) {
      stellaToast.add({
        title: successTitle,
        description: t("errors.actionFailed"),
        type: "warning",
        action: goToMatterAction,
        timeout: 10_000,
      });
    } else {
      stellaToast.add({
        title: successTitle,
        type: "success",
        action: goToMatterAction,
        timeout: 10_000,
      });
    }

    onOpenChange(false);
  };

  const handleClose = () => {
    setTarget(null);
    setMode("copy");
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspaces.copyToMatter.title")}</DialogTitle>
          <DialogDescription>
            {singleEntity
              ? t("workspaces.copyToMatter.description", {
                  name: singleEntity.entityName,
                })
              : t("workspaces.copyToMatter.descriptionCount", {
                  count: transferEntities.length,
                })}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          {/* Copy/Move toggle */}
          <div className="space-y-2">
            <Label>{t("workspaces.copyToMatter.operation")}</Label>
            <div className="flex gap-2">
              <Button
                onClick={() => setMode("copy")}
                size="sm"
                variant={mode === "copy" ? "default" : "outline"}
              >
                {t("workspaces.copyToMatter.copyOption")}
              </Button>
              <Button
                onClick={() => setMode("move")}
                size="sm"
                variant={mode === "move" ? "default" : "outline"}
              >
                {t("workspaces.copyToMatter.moveOption")}
              </Button>
            </div>
          </div>

          <MatterTargetPicker
            excludeWorkspaceId={sourceWorkspaceId}
            onChange={setTarget}
            value={target}
          />
        </DialogPanel>

        <DialogFooter>
          <Button onClick={handleClose} variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!target || isSubmitting}
            onClick={() => {
              detached(handleSubmit(), "copy-to-matter-dialog.submit");
            }}
          >
            {(() => {
              if (isSubmitting) {
                return t("common.loading");
              }
              if (mode === "copy") {
                return t("common.copy");
              }
              return t("workspaces.copyToMatter.moveButton");
            })()}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
