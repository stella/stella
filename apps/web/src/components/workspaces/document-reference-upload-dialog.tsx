import type { ReactNode } from "react";
import { useId, useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { detached } from "@/lib/detached";
import type { ReferenceUploadAction } from "@/lib/document-reference";
import {
  defaultReferenceUploadAction,
  DOCUMENT_REFERENCE_EVIDENCE,
  REFERENCE_UPLOAD_ACTION,
} from "@/lib/document-reference";
import type { ReferencedFile } from "@/lib/document-reference-queries";
import type { DocumentReferenceUploadPrompt } from "@/lib/document-reference-upload-store";
import { useDocumentReferenceUploadStore } from "@/lib/document-reference-upload-store";
import { useUploadVersion } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-upload-version";

/**
 * Asks what to do with uploaded files that turned out to be versions of
 * documents already in this organization.
 *
 * Mounted once at the protected layout; `useCreateFileEntities` raises the
 * question from whichever surface the files came in through. Files with no
 * reference never reach this dialog, so an ordinary upload is never
 * interrupted.
 *
 * Each row starts on what that file's own evidence argues for: one that kept
 * only the hidden property, its visible reference line deleted, starts on
 * "new document".
 */
export const DocumentReferenceUploadDialog = () => {
  const prompt = useDocumentReferenceUploadStore((store) => store.prompt);
  const promptId = useDocumentReferenceUploadStore((store) => store.promptId);
  const close = useDocumentReferenceUploadStore((store) => store.close);

  if (prompt === null) {
    return null;
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          prompt.onCancelled();
          close();
        }
      }}
      open
    >
      {/* Remounts per prompt, so the previous batch's choices cannot leak. */}
      <DocumentReferenceUploadDialogBody
        key={promptId}
        onClose={close}
        prompt={prompt}
      />
    </Dialog>
  );
};

type DocumentReferenceUploadDialogBodyProps = {
  prompt: DocumentReferenceUploadPrompt;
  onClose: () => void;
};

/**
 * One row's own identity and answer. Two files dropped from different folders
 * can share a filename, so the row carries an id rather than leaning on its
 * position in the batch.
 */
type ReferencedFileRowState = {
  id: string;
  entry: ReferencedFile;
  choice: ReferenceUploadAction;
};

const DocumentReferenceUploadDialogBody = ({
  prompt: { referenced, onResolved, onCancelled },
  onClose,
}: DocumentReferenceUploadDialogBodyProps) => {
  const t = useTranslations();
  const uploadVersion = useUploadVersion();
  const [rows, setRows] = useState<readonly ReferencedFileRowState[]>(() =>
    referenced.map((entry) => ({
      id: crypto.randomUUID(),
      entry,
      choice: defaultReferenceUploadAction(entry.evidence),
    })),
  );
  const [isSending, setIsSending] = useState(false);

  const confirm = async () => {
    setIsSending(true);
    const newDocumentFiles: File[] = [];
    for (const {
      entry: { file, match },
      choice,
    } of rows) {
      if (choice === REFERENCE_UPLOAD_ACTION.newDocument) {
        newDocumentFiles.push(file);
        continue;
      }
      // Sequential: each version upload is a separate document's history, and
      // the mutation reports its own outcome. Failures are surfaced there and
      // must not abandon the remaining files.
      await Result.tryPromise(
        async () =>
          await uploadVersion.mutateAsync({
            workspaceId: match.workspaceId,
            entityId: match.entityId,
            // A file document's name is its filename, which is all the
            // extension pre-check reads.
            entityFileName: match.entityName,
            file,
          }),
      );
    }
    onResolved(newDocumentFiles);
    onClose();
  };

  return (
    <DialogPopup className="max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {t("workspaces.files.referencedUpload.title")}
        </DialogTitle>
        <DialogDescription>
          {t("workspaces.files.referencedUpload.description", {
            count: referenced.length,
          })}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel className="flex flex-col gap-3">
        {rows.map((row) => (
          <ReferencedFileRow
            choice={row.choice}
            disabled={isSending}
            entry={row.entry}
            key={row.id}
            onChoiceChange={(choice) =>
              setRows((current) =>
                current.map((existing) =>
                  existing.id === row.id ? { ...existing, choice } : existing,
                ),
              )
            }
          />
        ))}
      </DialogPanel>

      <DialogFooter>
        <Button
          disabled={isSending}
          onClick={() => {
            onCancelled();
            onClose();
          }}
          variant="ghost"
        >
          {t("common.cancel")}
        </Button>
        <Button
          disabled={isSending}
          loading={isSending}
          onClick={() =>
            detached(confirm(), "document-reference-upload.confirm")
          }
        >
          {t("common.uploadFiles")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};

type ReferencedFileRowProps = {
  entry: ReferencedFile;
  choice: ReferenceUploadAction;
  onChoiceChange: (choice: ReferenceUploadAction) => void;
  disabled: boolean;
};

const ReferencedFileRow = ({
  entry: { file, match, evidence },
  choice,
  onChoiceChange,
  disabled,
}: ReferencedFileRowProps) => {
  const t = useTranslations();
  // Two files in one batch can share a filename, so the label cannot be tied
  // to the row by name.
  const selectId = useId();
  const bdi = (chunks: ReactNode) => <BidiText>{chunks}</BidiText>;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <span className="text-sm font-medium">
        <BidiText>{file.name}</BidiText>
      </span>
      <span className="text-muted-foreground text-xs">
        {t.rich("workspaces.files.referencedUpload.matchedDocument", {
          bdi,
          documentName:
            match.entityName ??
            t("workspaces.files.versionOrNewFile.unnamedDocument"),
          matterName: match.workspaceName,
          reference: match.stamp,
          version: match.versionNumber,
        })}
      </span>
      {match.versionNumber < match.currentVersionNumber && (
        <span className="text-muted-foreground text-xs">
          {t("workspaces.files.versionOrNewFile.referenceSuperseded", {
            basedOn: match.versionNumber,
            current: match.currentVersionNumber,
          })}
        </span>
      )}
      {evidence === DOCUMENT_REFERENCE_EVIDENCE.propertiesOnly && (
        <span className="text-muted-foreground text-xs">
          {t("workspaces.files.versionOrNewFile.referenceLineRemoved")}
        </span>
      )}
      <Label className="sr-only" htmlFor={selectId}>
        {t("workspaces.files.referencedUpload.choiceLabel", {
          fileName: file.name,
        })}
      </Label>
      <Select disabled={disabled} onValueChange={onChoiceChange} value={choice}>
        <SelectTrigger className="w-full" id={selectId} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={REFERENCE_UPLOAD_ACTION.version}>
            {t("workspaces.files.versionOrNewFile.addAsVersion", {
              version: match.currentVersionNumber + 1,
            })}
          </SelectItem>
          <SelectItem value={REFERENCE_UPLOAD_ACTION.newDocument}>
            {t("workspaces.files.referencedUpload.uploadAsNewDocument")}
          </SelectItem>
        </SelectPopup>
      </Select>
      {choice === REFERENCE_UPLOAD_ACTION.newDocument && (
        <span className="text-muted-foreground text-xs">
          {t("workspaces.files.versionOrNewFile.newDocumentDropsReference")}
        </span>
      )}
    </div>
  );
};
