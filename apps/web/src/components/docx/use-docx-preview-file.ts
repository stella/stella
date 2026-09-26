import type { RefObject } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  readDocxDocument,
  writeDocxDocument,
} from "@/components/docx/docx-document-cache";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { fileOptions } from "@/lib/files/queries";

import { selectPreviewFile } from "./docx-browser-editor.logic";
import type { OptimisticPreviewFile } from "./docx-browser-editor.logic";

type UseDocxPreviewFileOptions = {
  fieldId: string;
  optimisticPreviewRef: RefObject<OptimisticPreviewFile | null>;
  workspaceId: string;
};

/**
 * Loads the document bytes the editor opens, preferring the bytes a finalize
 * just saved until the refetch catches up. Throws the query error so the
 * surrounding boundary renders it.
 */
export const useDocxPreviewFile = ({
  fieldId,
  optimisticPreviewRef,
  workspaceId,
}: UseDocxPreviewFileOptions) => {
  /* oxlint-disable react/refs -- optimistic preview and its derived query data are deliberately carried across the finalize/refetch window in a mutable ref */
  const optimisticPreview = optimisticPreviewRef.current;
  const previewPlaceholderData =
    optimisticPreview?.fieldId === fieldId
      ? optimisticPreview.file
      : keepPreviousData;
  const previewFileQuery = useQuery({
    ...fileOptions({ workspaceId, fieldId, purpose: "native-display" }),
    placeholderData: previewPlaceholderData,
    // A reopened document starts from the bytes it was last loaded with —
    // real data, not a placeholder, and the same `ArrayBuffer` object, so
    // `shareFileData` can hand it straight back and Folio does not reparse a
    // document it already had. The original fetch time rides along, so the
    // query applies its own staleness rules rather than treating a cached copy
    // as fresh.
    initialData: () =>
      readDocxDocument({ fileFieldId: fieldId, workspaceId })?.value,
    initialDataUpdatedAt: () =>
      readDocxDocument({ fileFieldId: fieldId, workspaceId })?.dataUpdatedAt,
  });
  // Only the pristine server copy is cached. The edit-session buffers
  // (`lastEditingBufferRef`, `preservedLoadedBufferRef`) are selected by the
  // editor and always win, so a cached document can never replace live input.
  const loadedPreviewFile = previewFileQuery.isPlaceholderData
    ? null
    : (previewFileQuery.data ?? null);
  const loadedPreviewFileUpdatedAt = previewFileQuery.dataUpdatedAt;
  useExternalSyncEffect(() => {
    if (loadedPreviewFile === null) {
      return;
    }
    writeDocxDocument(
      { fileFieldId: fieldId, workspaceId },
      {
        dataUpdatedAt: loadedPreviewFileUpdatedAt,
        value: loadedPreviewFile,
      },
    );
  }, [fieldId, loadedPreviewFile, loadedPreviewFileUpdatedAt, workspaceId]);

  if (previewFileQuery.error) {
    throw previewFileQuery.error;
  }

  const previewFile = previewFileQuery.data
    ? selectPreviewFile({
        file: previewFileQuery.data,
        optimisticPreview,
        fieldId,
      })
    : null;
  /* oxlint-enable react/refs */

  return {
    isPlaceholderData: previewFileQuery.isPlaceholderData,
    previewFile,
  };
};
