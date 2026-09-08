import type { ReactNode } from "react";
import { useState } from "react";

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
import type { ReferencedFile } from "@/lib/document-reference-queries";
import type { DocumentReferenceUploadPrompt } from "@/lib/document-reference-upload-store";
import { useDocumentReferenceUploadStore } from "@/lib/document-reference-upload-store";
import { useUploadVersion } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-upload-version";

const REFERENCED_FILE_CHOICE = {
  /** File it onto the document its reference names. */
  version: "version",
  /** Ignore the reference and create a separate document. */
  newDocument: "new-document",
} as const;

type ReferencedFileChoice =
  (typeof REFERENCED_FILE_CHOICE)[keyof typeof REFERENCED_FILE_CHOICE];

/**
 * Asks what to do with uploaded files that turned out to be versions of
 * documents already in this organization.
 *
 * Mounted once at the protected layout; `useCreateFileEntities` raises the
 * question from whichever surface the files came in through. Files with no
 * reference never reach this dialog, so an ordinary upload is never
 * interrupted.
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

const DocumentReferenceUploadDialogBody = ({
  prompt: { referenced, onResolved, onCancelled },
  onClose,
}: DocumentReferenceUploadDialogBodyProps) => {
  const t = useTranslations();
  const uploadVersion = useUploadVersion();
  const [choices, setChoices] = useState<readonly ReferencedFileChoice[]>(() =>
    referenced.map(() => REFERENCED_FILE_CHOICE.version),
  );
  const [isSending, setIsSending] = useState(false);

  const confirm = async () => {
    setIsSending(true);
    const newDocumentFiles: File[] = [];
    for (const [index, { file, match }] of referenced.entries()) {
      if (choices[index] === REFERENCED_FILE_CHOICE.newDocument) {
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
        {referenced.map((entry, index) => (
          <ReferencedFileRow
            choice={choices[index] ?? REFERENCED_FILE_CHOICE.version}
            disabled={isSending}
            entry={entry}
            key={`${index}-${entry.file.name}`}
            onChoiceChange={(choice) =>
              setChoices((current) =>
                current.map((existing, at) =>
                  at === index ? choice : existing,
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
  choice: ReferencedFileChoice;
  onChoiceChange: (choice: ReferencedFileChoice) => void;
  disabled: boolean;
};

const ReferencedFileRow = ({
  entry: { file, match },
  choice,
  onChoiceChange,
  disabled,
}: ReferencedFileRowProps) => {
  const t = useTranslations();
  const selectId = `referenced-upload-${file.name}`;
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
          <SelectItem value={REFERENCED_FILE_CHOICE.version}>
            {t("workspaces.files.versionOrNewFile.addAsVersion", {
              version: match.currentVersionNumber + 1,
            })}
          </SelectItem>
          <SelectItem value={REFERENCED_FILE_CHOICE.newDocument}>
            {t("workspaces.files.referencedUpload.uploadAsNewDocument")}
          </SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
};
