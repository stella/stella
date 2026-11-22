import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogFormState,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { stellaToast } from "@stll/ui/toast";

import {
  MatterTargetPicker,
  useResolveMatterTarget,
} from "@/components/matter-target-picker";
import type { MatterTarget } from "@/components/matter-target-picker.logic";
import { usePermissions } from "@/hooks/use-permissions";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { downloadFilePart, saveFilePart } from "@/lib/files/file-part-queries";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type FilePartSource = { fieldId: string; workspaceId: string };

/**
 * Download and save-to-matter for the parts of one file, shared by every
 * container: the busy state of each, the matter picker and its dialog.
 */
export const useFilePartActions = ({
  fieldId,
  workspaceId,
}: FilePartSource) => {
  const t = useTranslations();
  const canSave = usePermissions({ entity: ["create"] });
  const queryClient = useQueryClient();
  const resolveTarget = useResolveMatterTarget();
  const [pickerPart, setPickerPart] = useState<string | null>(null);
  const [matterTarget, setMatterTarget] = useState<MatterTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const save = (part: string, destination: MatterTarget): void => {
    if (savingRef.current) {
      return;
    }
    savingRef.current = true;
    setSaving(true);
    detached(
      (async () => {
        const finish = () => {
          savingRef.current = false;
          setSaving(false);
        };
        const resolved = await resolveTarget(destination);
        if (Result.isError(resolved)) {
          finish();
          notifyUserError(resolved.error, t("errors.actionFailed"));
          return;
        }
        if (destination.type === "pending") {
          // A staged folder now exists; keep it so a retry after a failed save
          // does not create a second one.
          setMatterTarget({
            type: "existing",
            workspaceId: resolved.value.workspaceId,
            parentId: resolved.value.parentId,
          });
        }
        const result = await Result.tryPromise(async () => {
          const saved = await saveFilePart({
            workspaceId,
            fieldId,
            part,
            destinationWorkspaceId: resolved.value.workspaceId,
            parentId: resolved.value.parentId,
          });
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: entitiesKeys.all(saved.workspaceId),
            }),
            queryClient.invalidateQueries({
              queryKey: workspacesKeys.overview(saved.workspaceId),
            }),
            queryClient.invalidateQueries({ queryKey: workspacesKeys.all }),
          ]);
        });
        finish();
        if (Result.isError(result)) {
          notifyUserError(result.error, t("errors.actionFailed"));
          return;
        }
        setPickerPart(null);
        setMatterTarget(null);
        stellaToast.add({
          title: t("workspaces.copyToMatter.copied"),
          type: "success",
        });
      })(),
      "file-part.save",
    );
  };

  const download = (part: string): void => {
    setDownloading((current) => new Set(current).add(part));
    detached(
      (async () => {
        const result = await Result.tryPromise(
          async () => await downloadFilePart({ workspaceId, fieldId, part }),
        );
        setDownloading((current) => {
          const next = new Set(current);
          next.delete(part);
          return next;
        });
        if (Result.isError(result)) {
          notifyUserError(result.error, t("workspaces.files.downloadFailed"));
        }
      })(),
      "file-part.download",
    );
  };

  const closePicker = () => {
    setMatterTarget(null);
    setPickerPart(null);
  };

  const dialog = (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          closePicker();
        }
      }}
      open={pickerPart !== null}
    >
      <DialogPopup className="max-w-lg">
        <DialogFormState
          dirty={matterTarget !== null}
          onDiscard={() => setMatterTarget(null)}
        />
        <DialogHeader>
          <DialogTitle>{t("common.selectAMatter")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <MatterTargetPicker
            excludeWorkspaceId={workspaceId}
            onChange={setMatterTarget}
            value={matterTarget}
          />
        </DialogPanel>
        <DialogFooter>
          <Button onClick={closePicker} variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button
            disabled={matterTarget === null || saving}
            disabledReason={
              saving ? t("common.saving") : t("common.selectAMatter")
            }
            onClick={() => {
              if (matterTarget !== null && pickerPart !== null) {
                save(pickerPart, matterTarget);
              }
            }}
          >
            {saving ? t("common.loading") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  return {
    canSave,
    saving,
    /** Saves the part into the matter the file belongs to. */
    saveHere: (part: string) => {
      save(part, { type: "existing", workspaceId, parentId: null });
    },
    /** Opens the matter picker for the part. */
    chooseMatter: (part: string) => {
      setMatterTarget(null);
      setPickerPart(part);
    },
    download,
    isDownloading: (part: string) => downloading.has(part),
    dialog,
  };
};

export type FilePartActions = ReturnType<typeof useFilePartActions>;
