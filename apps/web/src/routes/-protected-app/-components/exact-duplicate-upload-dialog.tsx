import type { ReactNode } from "react";
import { useId, useState } from "react";

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

import type { DuplicateFile } from "@/lib/files/exact-duplicate-queries";
import type { ExactDuplicateUploadPrompt } from "@/lib/files/exact-duplicate-upload-store";
import { useExactDuplicateUploadStore } from "@/lib/files/exact-duplicate-upload-store";
import { createUuid } from "@/lib/uuid";

const DUPLICATE_UPLOAD_ACTION = {
  skip: "skip",
  uploadAnyway: "uploadAnyway",
} as const;

type DuplicateUploadAction =
  (typeof DUPLICATE_UPLOAD_ACTION)[keyof typeof DUPLICATE_UPLOAD_ACTION];

type DuplicateFileRowState = {
  id: string;
  entry: DuplicateFile;
  choice: DuplicateUploadAction;
};

/**
 * Asks what to do with uploaded files whose exact bytes the matter already
 * holds. Mounted once at the protected layout, beside the document-reference
 * dialog; a batch with no duplicate never opens it.
 */
export const ExactDuplicateUploadDialog = () => {
  const prompt = useExactDuplicateUploadStore(
    (store) => store.prompts.at(0) ?? null,
  );
  const close = useExactDuplicateUploadStore((store) => store.close);

  if (prompt === null) {
    return null;
  }

  return (
    <ExactDuplicateUploadDialogBody
      key={prompt.id}
      onClose={() => close(prompt.id)}
      prompt={prompt}
    />
  );
};

type ExactDuplicateUploadDialogBodyProps = {
  prompt: ExactDuplicateUploadPrompt;
  onClose: () => void;
};

const ExactDuplicateUploadDialogBody = ({
  prompt: { duplicates, onResolved },
  onClose,
}: ExactDuplicateUploadDialogBodyProps) => {
  const t = useTranslations();
  const [rows, setRows] = useState<readonly DuplicateFileRowState[]>(() =>
    duplicates.map((entry) => ({
      id: createUuid(),
      entry,
      choice: DUPLICATE_UPLOAD_ACTION.skip,
    })),
  );

  const confirm = () => {
    onResolved(
      rows
        .filter((row) => row.choice === DUPLICATE_UPLOAD_ACTION.uploadAnyway)
        .map((row) => row.entry.file),
    );
    onClose();
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("workspaces.files.duplicateUpload.title")}
          </DialogTitle>
          <DialogDescription>
            {t("workspaces.files.duplicateUpload.description", {
              count: rows.length,
            })}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-3">
          {rows.map((row) => (
            <DuplicateFileRow
              choice={row.choice}
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
          <Button onClick={onClose} variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm}>{t("common.confirm")}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type DuplicateFileRowProps = {
  entry: DuplicateFile;
  choice: DuplicateUploadAction;
  onChoiceChange: (choice: DuplicateUploadAction) => void;
};

const DuplicateFileRow = ({
  entry: { file, entityName },
  choice,
  onChoiceChange,
}: DuplicateFileRowProps) => {
  const t = useTranslations();
  const selectId = useId();
  const bdi = (chunks: ReactNode) => <BidiText>{chunks}</BidiText>;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <span className="text-sm font-medium">
        <BidiText>{file.name}</BidiText>
      </span>
      <span className="text-muted-foreground text-xs">
        {t.rich("workspaces.files.duplicateUpload.matchedDocument", {
          bdi,
          documentName:
            entityName ??
            t("workspaces.files.versionOrNewFile.unnamedDocument"),
        })}
      </span>
      <Label className="sr-only" htmlFor={selectId}>
        {t("workspaces.files.referencedUpload.choiceLabel", {
          fileName: file.name,
        })}
      </Label>
      <Select
        onValueChange={(nextChoice) => {
          if (nextChoice !== null) {
            onChoiceChange(nextChoice);
          }
        }}
        value={choice}
      >
        <SelectTrigger className="w-full" id={selectId} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={DUPLICATE_UPLOAD_ACTION.skip}>
            {t("workspaces.files.duplicateUpload.skip")}
          </SelectItem>
          <SelectItem value={DUPLICATE_UPLOAD_ACTION.uploadAnyway}>
            {t("workspaces.files.duplicateUpload.uploadAnyway")}
          </SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
};
