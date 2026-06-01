import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { cn } from "@stll/ui/lib/utils";

import { extensionMatches, getExtension } from "./file-extension";

type VersionOrNewFileDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  /** The filename of the existing entity's file */
  entityFileName: string | null | undefined;
  /** The file being dropped */
  droppedFile: File;
  /** Callback when user chooses to replace as new version */
  onReplaceVersion: () => void;
  /** Callback when user chooses to create a new file */
  onCreateNewFile: () => void;
  /** Whether the replace version action is in progress */
  isReplacePending?: boolean;
};

export const VersionOrNewFileDialog = ({
  open,
  onOpenChange,
  onOpenChangeComplete,
  entityFileName,
  droppedFile,
  onReplaceVersion,
  onCreateNewFile,
  isReplacePending = false,
}: VersionOrNewFileDialogProps) => {
  const canReplace = extensionMatches({
    entityFileName,
    uploadFileName: droppedFile.name,
  });

  const entityExt = entityFileName ? getExtension(entityFileName) : null;
  const uploadExt = getExtension(droppedFile.name);

  return (
    <Dialog
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      open={open}
    >
      <VersionOrNewFileDialogBody
        canReplace={canReplace}
        droppedFileName={droppedFile.name}
        entityExt={entityExt}
        isReplacePending={isReplacePending}
        onCancel={() => onOpenChange(false)}
        onCreateNewFile={onCreateNewFile}
        onReplaceVersion={onReplaceVersion}
        uploadExt={uploadExt}
      />
    </Dialog>
  );
};

type VersionOrNewFileDialogBodyProps = {
  canReplace: boolean;
  droppedFileName: string;
  entityExt: string | null;
  uploadExt: string | null;
  onReplaceVersion: () => void;
  onCreateNewFile: () => void;
  onCancel: () => void;
  isReplacePending: boolean;
};

const VersionOrNewFileDialogBody = ({
  canReplace,
  droppedFileName,
  entityExt,
  uploadExt,
  onReplaceVersion,
  onCreateNewFile,
  onCancel,
  isReplacePending,
}: VersionOrNewFileDialogBodyProps) => {
  const t = useTranslations();

  return (
    <DialogPopup className="max-w-md">
      <DialogHeader>
        <DialogTitle>
          {t("workspaces.files.versionOrNewFile.title")}
        </DialogTitle>
        <DialogDescription>
          {t("workspaces.files.versionOrNewFile.description", {
            fileName: droppedFileName,
          })}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel className="space-y-3">
        {/* Replace as new version option */}
        <button
          className={cn(
            "hover:bg-accent w-full rounded-lg border p-3 text-start transition-colors",
            !canReplace && "cursor-not-allowed opacity-50",
            canReplace && "hover:border-primary",
          )}
          disabled={!canReplace || isReplacePending}
          onClick={onReplaceVersion}
          type="button"
        >
          <div className="font-medium">
            {t("workspaces.files.versionOrNewFile.replaceOption")}
          </div>
          <div className="text-muted-foreground text-sm">
            {canReplace
              ? t("workspaces.files.versionOrNewFile.replaceDescription")
              : t("workspaces.files.versionOrNewFile.extensionMismatch", {
                  expected: entityExt
                    ? `.${entityExt}`
                    : t("workspaces.files.versionOrNewFile.noExtension"),
                  actual: uploadExt
                    ? `.${uploadExt}`
                    : t("workspaces.files.versionOrNewFile.noExtension"),
                })}
          </div>
        </button>

        {/* Create new file option */}
        <button
          className="hover:bg-accent hover:border-primary w-full rounded-lg border p-3 text-start transition-colors"
          disabled={isReplacePending}
          onClick={onCreateNewFile}
          type="button"
        >
          <div className="font-medium">
            {t("workspaces.files.versionOrNewFile.createNewOption")}
          </div>
          <div className="text-muted-foreground text-sm">
            {t("workspaces.files.versionOrNewFile.createNewDescription")}
          </div>
        </button>
      </DialogPanel>

      <DialogFooter>
        <Button disabled={isReplacePending} onClick={onCancel} variant="ghost">
          {t("common.cancel")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};
