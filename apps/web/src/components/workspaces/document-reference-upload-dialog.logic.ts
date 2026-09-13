import { Result, panic } from "better-result";

import type { ReferenceUploadAction } from "@/lib/files/document-reference";
import { REFERENCE_UPLOAD_ACTION } from "@/lib/files/document-reference";
import type { ReferencedFile } from "@/lib/files/document-reference-queries";

export type ReferencedFileRowState = {
  id: string;
  entry: ReferencedFile;
  choice: ReferenceUploadAction;
};

type UploadReferencedVersionsOptions = {
  rows: readonly ReferencedFileRowState[];
  uploadVersion: (entry: ReferencedFile) => Promise<Result<unknown, unknown>>;
};

export type ReferencedVersionUploadOutcome =
  | {
      type: "complete";
      newDocumentFiles: readonly File[];
    }
  | {
      type: "retry";
      rows: readonly ReferencedFileRowState[];
    };

/**
 * Upload every selected version once. Successful rows leave the next attempt;
 * failed rows and untouched new-document choices stay in their original order.
 */
export const uploadReferencedVersions = async ({
  rows,
  uploadVersion,
}: UploadReferencedVersionsOptions): Promise<ReferencedVersionUploadOutcome> => {
  const failedVersionRowIds = new Set<string>();
  const newDocumentFiles: File[] = [];

  for (const row of rows) {
    switch (row.choice) {
      case REFERENCE_UPLOAD_ACTION.newDocument:
        newDocumentFiles.push(row.entry.file);
        break;
      case REFERENCE_UPLOAD_ACTION.version: {
        const result = await uploadVersion(row.entry);
        if (Result.isError(result)) {
          failedVersionRowIds.add(row.id);
        }
        break;
      }
      default: {
        row.choice satisfies never;
        return panic("Unhandled document reference upload action");
      }
    }
  }

  if (failedVersionRowIds.size === 0) {
    return { type: "complete", newDocumentFiles };
  }

  return {
    type: "retry",
    rows: rows.filter(
      (row) =>
        row.choice === REFERENCE_UPLOAD_ACTION.newDocument ||
        failedVersionRowIds.has(row.id),
    ),
  };
};
