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

/** Where a part is saved: a matter, and a folder in it or its root. */
type FilePartDestination = { workspaceId: string; parentId: string | null };

/**
 * Download and save-to-matter for the parts of one file, shared by every
 * container: the busy state of each, and the matter picker's dialog.
 */
export const useFilePartActions = ({
  fieldId,
  workspaceId,
}: FilePartSource) => {
  const t = useTranslations();
  const canSave = usePermissions({ entity: ["create"] });
  const queryClient = useQueryClient();
  const [pickerPart, setPickerPart] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  /** Saves the part; resolves whether it was saved. */
  const save = async (
    part: string,
    destination: FilePartDestination,
  ): Promise<boolean> => {
    if (savingRef.current) {
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    const result = await Result.tryPromise(async () => {
      const saved = await saveFilePart({
        workspaceId,
        fieldId,
        part,
        destinationWorkspaceId: destination.workspaceId,
        parentId: destination.parentId,
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
    savingRef.current = false;
    setSaving(false);
    if (Result.isError(result)) {
      notifyUserError(result.error, t("errors.actionFailed"));
      return false;
    }
    stellaToast.add({
      title: t("workspaces.copyToMatter.copied"),
      type: "success",
    });
    return true;
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

  const dialog = (
    <FilePartMatterDialog
      excludeWorkspaceId={workspaceId}
      onClose={() => setPickerPart(null)}
      onSave={async (destination) =>
        pickerPart === null ? false : await save(pickerPart, destination)
      }
      open={pickerPart !== null}
      saving={saving}
    />
  );

  return {
    canSave,
    saving,
    /** Saves the part into the matter the file belongs to. */
    saveHere: (part: string) => {
      detached(
        save(part, { workspaceId, parentId: null }),
        "file-part.save-here",
      );
    },
    /** Opens the matter picker for the part. */
    chooseMatter: (part: string) => {
      setPickerPart(part);
    },
    download,
    isDownloading: (part: string) => downloading.has(part),
    dialog,
  };
};

export type FilePartActions = ReturnType<typeof useFilePartActions>;

/** Picks the matter (or a new one) a part is saved to. */
const FilePartMatterDialog = ({
  excludeWorkspaceId,
  onClose,
  onSave,
  open,
  saving,
}: {
  excludeWorkspaceId: string;
  onClose: () => void;
  onSave: (destination: FilePartDestination) => Promise<boolean>;
  open: boolean;
  saving: boolean;
}) => {
  const t = useTranslations();
  const resolveTarget = useResolveMatterTarget();
  const [matterTarget, setMatterTarget] = useState<MatterTarget | null>(null);
  const [resolving, setResolving] = useState(false);
  const busy = saving || resolving;

  const close = () => {
    setMatterTarget(null);
    onClose();
  };
  const submit = (target: MatterTarget) => {
    setResolving(true);
    detached(
      (async () => {
        const resolved = await resolveTarget(target);
        setResolving(false);
        if (Result.isError(resolved)) {
          notifyUserError(resolved.error, t("errors.actionFailed"));
          return;
        }
        if (target.type === "pending") {
          // A staged folder now exists; keep it so a retry after a failed
          // save does not create a second one.
          setMatterTarget({
            type: "existing",
            workspaceId: resolved.value.workspaceId,
            parentId: resolved.value.parentId,
          });
        }
        if (await onSave(resolved.value)) {
          close();
        }
      })(),
      "file-part.save-to-matter",
    );
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      open={open}
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
            excludeWorkspaceId={excludeWorkspaceId}
            onChange={setMatterTarget}
            value={matterTarget}
          />
        </DialogPanel>
        <DialogFooter>
          <Button onClick={close} variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button
            disabled={matterTarget === null || busy}
            disabledReason={
              busy ? t("common.saving") : t("common.selectAMatter")
            }
            onClick={() => {
              if (matterTarget !== null) {
                submit(matterTarget);
              }
            }}
          >
            {busy ? t("common.loading") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
