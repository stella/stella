import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";

import { REFERENCE_UPLOAD_ACTION } from "@/lib/document-reference";
import type {
  VersionOrNewFileChoice,
  VersionOrNewFileDecision,
} from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog.logic";
import { VERSION_OR_NEW_FILE_CHOICE } from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog.logic";

export type VersionOrNewFileDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  droppedFileName: string;
  /** Null while the dropped file's reference is still being resolved. */
  decision: VersionOrNewFileDecision | null;
  onChoose: (choice: VersionOrNewFileChoice) => void;
  isUploadPending: boolean;
};

export const VersionOrNewFileDialog = ({
  open,
  onOpenChange,
  onOpenChangeComplete,
  droppedFileName,
  decision,
  onChoose,
  isUploadPending,
}: VersionOrNewFileDialogProps) => (
  <Dialog
    onOpenChange={onOpenChange}
    onOpenChangeComplete={onOpenChangeComplete}
    open={open}
  >
    <VersionOrNewFileDialogBody
      decision={decision}
      droppedFileName={droppedFileName}
      isUploadPending={isUploadPending}
      onCancel={() => onOpenChange(false)}
      onChoose={onChoose}
    />
  </Dialog>
);

type VersionOrNewFileDialogBodyProps = {
  decision: VersionOrNewFileDecision | null;
  droppedFileName: string;
  onChoose: (choice: VersionOrNewFileChoice) => void;
  onCancel: () => void;
  isUploadPending: boolean;
};

const VersionOrNewFileDialogBody = ({
  decision,
  droppedFileName,
  onChoose,
  onCancel,
  isUploadPending,
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
          })}{" "}
          <DecisionNote decision={decision} />
        </DialogDescription>
        <RemovedReferenceLineNote decision={decision} />
      </DialogHeader>

      <DialogFooter>
        <Button disabled={isUploadPending} onClick={onCancel} variant="ghost">
          {t("common.cancel")}
        </Button>
        <DecisionActions
          decision={decision}
          isUploadPending={isUploadPending}
          onChoose={onChoose}
        />
      </DialogFooter>
    </DialogPopup>
  );
};

/**
 * What the file turned out to be. The reference it carries names its document
 * outright; without one, all that can be said is whether the extensions agree.
 */
const DecisionNote = ({
  decision,
}: {
  decision: VersionOrNewFileDecision | null;
}): ReactNode => {
  const t = useTranslations();

  if (decision === null) {
    return t("workspaces.files.versionOrNewFile.checkingReference");
  }

  if (decision.type === "extension") {
    if (decision.canReplace) {
      return null;
    }
    const noExtension = t("workspaces.files.versionOrNewFile.noExtension");
    return t("workspaces.files.versionOrNewFile.extensionMismatch", {
      expected: decision.entityExtension
        ? `.${decision.entityExtension}`
        : noExtension,
      actual: decision.uploadExtension
        ? `.${decision.uploadExtension}`
        : noExtension,
    });
  }

  const { document, supersededBase } = decision;
  const documentName =
    document.documentName ??
    t("workspaces.files.versionOrNewFile.unnamedDocument");
  const bdi = (chunks: ReactNode) => <BidiText>{chunks}</BidiText>;

  return (
    <>
      {decision.type === "reference-here"
        ? t.rich("workspaces.files.versionOrNewFile.referenceHere", {
            bdi,
            documentName,
            reference: document.documentReference,
            version: document.versionNumber,
          })
        : t.rich("workspaces.files.versionOrNewFile.referenceElsewhere", {
            bdi,
            documentName,
            matterName: document.matterName,
            reference: document.documentReference,
            version: document.versionNumber,
          })}
      {supersededBase && (
        <>
          {" "}
          {t("workspaces.files.versionOrNewFile.referenceSuperseded", {
            basedOn: supersededBase.basedOnVersionNumber,
            current: supersededBase.currentVersionNumber,
          })}
        </>
      )}
    </>
  );
};

type DecisionActionsProps = {
  decision: VersionOrNewFileDecision | null;
  onChoose: (choice: VersionOrNewFileChoice) => void;
  isUploadPending: boolean;
};

/**
 * One decision, one primary action. The reference the file carries decides
 * which action that is; without one, matching extensions do.
 */
const DecisionActions = ({
  decision,
  onChoose,
  isUploadPending,
}: DecisionActionsProps): ReactNode => {
  const t = useTranslations();

  if (decision === null) {
    return (
      <Button disabled loading>
        {t("workspaces.files.versionOrNewFile.replaceOption")}
      </Button>
    );
  }

  switch (decision.type) {
    case "extension": {
      return (
        <>
          <Button
            disabled={isUploadPending}
            onClick={() => onChoose(VERSION_OR_NEW_FILE_CHOICE.newDocument)}
            variant="outline"
          >
            {t("workspaces.files.versionOrNewFile.createNewOption")}
          </Button>
          <Button
            disabled={!decision.canReplace || isUploadPending}
            loading={isUploadPending}
            onClick={() => onChoose(VERSION_OR_NEW_FILE_CHOICE.versionHere)}
          >
            {t("workspaces.files.versionOrNewFile.replaceOption")}
          </Button>
        </>
      );
    }
    case "reference-here":
    case "reference-elsewhere": {
      return (
        <ReferenceActions
          decision={decision}
          isUploadPending={isUploadPending}
          onChoose={onChoose}
        />
      );
    }
    default: {
      return panic(`Unhandled decision: ${String(decision satisfies never)}`);
    }
  }
};

type ReferenceDecision = Extract<
  VersionOrNewFileDecision,
  { type: "reference-here" | "reference-elsewhere" }
>;

type ReferenceActionsProps = {
  decision: ReferenceDecision;
  onChoose: (choice: VersionOrNewFileChoice) => void;
  isUploadPending: boolean;
};

/**
 * Both offers, ordered by the one the file's own evidence argues for. The
 * version upload carries the pending state either way: it is the only choice
 * that sends bytes from this dialog.
 */
const ReferenceActions = ({
  decision,
  onChoose,
  isUploadPending,
}: ReferenceActionsProps): ReactNode => {
  const t = useTranslations();
  const isElsewhere = decision.type === "reference-elsewhere";
  const leadsWithNewDocument =
    decision.defaultAction === REFERENCE_UPLOAD_ACTION.newDocument;

  const versionButton = (
    <Button
      disabled={isUploadPending}
      loading={isUploadPending}
      onClick={() =>
        onChoose(
          isElsewhere
            ? VERSION_OR_NEW_FILE_CHOICE.versionElsewhere
            : VERSION_OR_NEW_FILE_CHOICE.versionHere,
        )
      }
      variant={leadsWithNewDocument ? "outline" : "default"}
    >
      {isElsewhere
        ? t("workspaces.files.versionOrNewFile.addAsVersionThere", {
            version: decision.document.nextVersionNumber,
          })
        : t("workspaces.files.versionOrNewFile.addAsVersion", {
            version: decision.document.nextVersionNumber,
          })}
    </Button>
  );

  const newDocumentButton = (
    <Button
      disabled={isUploadPending}
      onClick={() => onChoose(VERSION_OR_NEW_FILE_CHOICE.newDocument)}
      variant={leadsWithNewDocument ? "default" : "outline"}
    >
      {isElsewhere
        ? t("workspaces.files.versionOrNewFile.uploadAsNewDocumentHere")
        : t("workspaces.files.versionOrNewFile.createNewOption")}
    </Button>
  );

  if (leadsWithNewDocument) {
    return (
      <>
        {versionButton}
        {newDocumentButton}
      </>
    );
  }
  return (
    <>
      {newDocumentButton}
      {versionButton}
    </>
  );
};

/**
 * Why the dialog is steering towards a new document, and what that costs. It
 * appears only for a file whose visible reference line is gone, the one case
 * where the version upload is not the primary action.
 */
const RemovedReferenceLineNote = ({
  decision,
}: {
  decision: VersionOrNewFileDecision | null;
}): ReactNode => {
  const t = useTranslations();

  if (
    decision === null ||
    decision.type === "extension" ||
    decision.defaultAction !== REFERENCE_UPLOAD_ACTION.newDocument
  ) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-sm">
      {t("workspaces.files.versionOrNewFile.referenceLineRemoved")}{" "}
      {t("workspaces.files.versionOrNewFile.newDocumentDropsReference")}
    </p>
  );
};
