/**
 * Hook managing chat file attachment state: upload, remove,
 * drain for send, and DOM event handlers (paste, drop, file
 * input change).
 */

import { useCallback, useRef, useState } from "react";

import { useTranslations } from "use-intl";

import type { ProcessedAttachment } from "@/lib/ai-sdk/rivet-transport";
import { api } from "@/lib/api";

const CHAT_CONTEXT_FILES_PER_MESSAGE = 5;

const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/csv",
  "text/markdown",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const FILE_INPUT_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.txt,.csv,.md";

type PendingFile = {
  id: string;
  filename: string;
  mimeType: string;
  status: "uploading" | "ready" | "error";
  attachment?: ProcessedAttachment;
  errorMessage?: string;
};

export const useChatAttachments = () => {
  const t = useTranslations();
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileIdCounterRef = useRef(0);
  const pendingCountRef = useRef(0);
  pendingCountRef.current = pendingFiles.length;

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = [...files];

      const newPending: PendingFile[] = [];
      const filesToUpload: File[] = [];

      for (const file of fileArray) {
        if (
          pendingCountRef.current + newPending.length >=
          CHAT_CONTEXT_FILES_PER_MESSAGE
        ) {
          break;
        }

        if (!ALLOWED_MIMES.has(file.type)) {
          continue;
        }

        if (file.size > MAX_FILE_SIZE) {
          continue;
        }

        fileIdCounterRef.current += 1;
        const id = `file-${fileIdCounterRef.current}`;
        newPending.push({
          id,
          filename: file.name,
          mimeType: file.type,
          status: "uploading",
        });
        filesToUpload.push(file);
      }

      if (newPending.length === 0) {
        return;
      }

      pendingCountRef.current += newPending.length;
      setPendingFiles((prev) => [...prev, ...newPending]);
      await Promise.allSettled(
        filesToUpload.map(async (file, i) => {
          const pending = newPending[i];
          if (!pending) {
            return;
          }

          const { data, error } = await api.chat["upload-context-file"].post({
            file,
          });

          if (
            (error !== undefined && error !== null) ||
            data === undefined ||
            data === null
          ) {
            setPendingFiles((prev) =>
              prev.map((f) =>
                f.id === pending.id
                  ? {
                      ...f,
                      status: "error" as const,
                      errorMessage: t("chat.uploadFailed"),
                    }
                  : f,
              ),
            );
            return;
          }

          // SAFETY: the Eden response matches
          // ProcessedAttachment since the endpoint
          // returns that exact shape.
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          const attachment = data as ProcessedAttachment;

          setPendingFiles((prev) =>
            prev.map((f) =>
              f.id === pending.id
                ? {
                    ...f,
                    status: "ready" as const,
                    attachment,
                  }
                : f,
            ),
          );
        }),
      );
    },
    [t],
  );

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  /** Drain ready attachments and clear state.
   *  Returns the attachments to send with the message. */
  const drainAttachments = useCallback((): ProcessedAttachment[] => {
    const ready = pendingFiles
      .filter(
        (f): f is PendingFile & { attachment: ProcessedAttachment } =>
          f.status === "ready" && f.attachment !== undefined,
      )
      .map((f) => f.attachment);
    setPendingFiles([]);
    return ready;
  }, [pendingFiles]);

  // -- DOM event handlers (shared by NewChat + ActiveThread) --

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const { files } = e.dataTransfer;
      if (files.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        addFiles(files);
      }
    },
    [addFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files: File[] = [];
      for (const item of e.clipboardData.items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        addFiles(files);
      }
    },
    [addFiles],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = e.target;
      if (files && files.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        addFiles(files);
      }
      e.target.value = "";
    },
    [addFiles],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const isUploading = pendingFiles.some((f) => f.status === "uploading");
  const hasErrors = pendingFiles.some((f) => f.status === "error");
  /** True when there are pending files that aren't ready
   *  yet (uploading or errored). Disable send in this state. */
  const isSendBlocked = pendingFiles.length > 0 && (isUploading || hasErrors);

  return {
    pendingFiles,
    drainAttachments,
    removeFile,
    isUploading,
    isSendBlocked,
    fileInputRef,
    openFilePicker,
    fileInputAccept: FILE_INPUT_ACCEPT,
    /** Spread on the container div that should accept
     *  paste and drop events. */
    dropZoneProps: {
      onDrop: handleDrop,
      onDragOver: handleDragOver,
      onPaste: handlePaste,
    },
    /** Props for the hidden <input type="file">. */
    fileInputProps: {
      ref: fileInputRef,
      type: "file" as const,
      className: "hidden",
      multiple: true,
      accept: FILE_INPUT_ACCEPT,
      onChange: handleFileInputChange,
    },
  };
};
