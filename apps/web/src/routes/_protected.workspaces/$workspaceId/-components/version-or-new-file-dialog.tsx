import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";

import { extensionMatches, getExtension } from "./file-extension";

type VersionOrNewFileDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  entityFileName: string | null | undefined;
  droppedFile: File;
  onReplaceVersion: () => void;
  onCreateNewFile: () => void;
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
  const noExt = t("workspaces.files.versionOrNewFile.noExtension");

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
          {!canReplace && (
            <>
              {" "}
              {t("workspaces.files.versionOrNewFile.extensionMismatch", {
                expected: entityExt ? `.${entityExt}` : noExt,
                actual: uploadExt ? `.${uploadExt}` : noExt,
              })}
            </>
          )}
        </DialogDescription>
      </DialogHeader>

      <DialogFooter>
        <Button disabled={isReplacePending} onClick={onCancel} variant="ghost">
          {t("common.cancel")}
        </Button>
        <Button
          disabled={isReplacePending}
          onClick={onCreateNewFile}
          variant="outline"
        >
          {t("workspaces.files.versionOrNewFile.createNewOption")}
        </Button>
        <Button
          disabled={!canReplace || isReplacePending}
          loading={isReplacePending}
          onClick={onReplaceVersion}
        >
          {t("workspaces.files.versionOrNewFile.replaceOption")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};
