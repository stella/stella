import {
  CHAT_FILE_TYPE_CONFIG,
  isChatFileMimeType,
} from "@stll/api-contract/chat-file-types";
import type { ChatFileMimeType } from "@stll/api-contract/chat-file-types";
import { CHAT_CONTEXT_FILE_MAX_BYTES } from "@stll/chat-limits";

import type { ApiError } from "@/state/api-request";

/** The files one message may carry, as the server and the web composer allow. */
export const CHAT_FILES_PER_MESSAGE = 5;

/** The largest file chat takes, as the server checks it. */
export const CHAT_FILE_MAX_BYTES = CHAT_CONTEXT_FILE_MAX_BYTES;

/** The types the system document picker offers: those chat takes. */
export const CHAT_FILE_PICKER_TYPES: readonly ChatFileMimeType[] =
  CHAT_FILE_TYPE_CONFIG.map(({ mimeType }) => mimeType);

/** A file the person chose, as the picker or the scanner hands it over. */
export type PickedFile = {
  readonly uri: string;
  readonly name: string;
  /** Absent when the picker could not tell; the name's extension then decides. */
  readonly mimeType?: string | null | undefined;
  /** Absent when the picker could not tell; the read bytes then decide. */
  readonly size?: number | null | undefined;
};

/** Why a file was left out of the message. */
export type AttachmentRefusal = "unsupported" | "too-large" | "too-many";

/**
 * A file in the composer: read from the phone into the data URL it is sent
 * as, then ready, or failed to read.
 */
export type ChatAttachment = {
  readonly id: string;
  readonly uri: string;
  readonly name: string;
  readonly mimeType: ChatFileMimeType;
  /** Bytes, once known. */
  readonly size: number | undefined;
  readonly state:
    | { readonly status: "reading" }
    | { readonly status: "ready"; readonly dataUrl: string }
    | { readonly status: "failed" };
};

/** A file as a sent message carries it, and as the thread shows it. */
export type SentFile = {
  readonly name: string;
  readonly mimeType: string;
};

/**
 * The chat type of a picked file: the type the picker named when chat takes
 * it, else the one its extension names. Undefined when chat takes neither.
 */
export const chatFileMimeType = (
  name: string,
  mimeType: string | null | undefined,
): ChatFileMimeType | undefined => {
  if (mimeType !== null && mimeType !== undefined) {
    const declared = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (isChatFileMimeType(declared)) {
      return declared;
    }
  }
  const lower = name.toLowerCase();
  return CHAT_FILE_TYPE_CONFIG.find(({ extensions }) =>
    extensions.some((extension) => lower.endsWith(extension)),
  )?.mimeType;
};

/**
 * Picked files added to those already in the composer, each to be read.
 * Files chat does not take, files over the size limit and files past the
 * per-message limit are left out, and the first reason one was is reported.
 */
export const admitPickedFiles = ({
  current,
  newId,
  picked,
}: {
  readonly current: readonly ChatAttachment[];
  readonly newId: () => string;
  readonly picked: readonly PickedFile[];
}): {
  readonly added: readonly ChatAttachment[];
  readonly refused: AttachmentRefusal | undefined;
} => {
  const added: ChatAttachment[] = [];
  let refused: AttachmentRefusal | undefined = undefined;
  for (const file of picked) {
    const mimeType = chatFileMimeType(file.name, file.mimeType);
    const size = typeof file.size === "number" ? file.size : undefined;
    if (mimeType === undefined) {
      refused ??= "unsupported";
      continue;
    }
    if (size !== undefined && size > CHAT_FILE_MAX_BYTES) {
      refused ??= "too-large";
      continue;
    }
    if (current.length + added.length >= CHAT_FILES_PER_MESSAGE) {
      refused ??= "too-many";
      continue;
    }
    added.push({
      id: newId(),
      uri: file.uri,
      name: file.name,
      mimeType,
      size,
      state: { status: "reading" },
    });
  }
  return { added, refused };
};

/** The bytes a base64 payload holds. */
export const base64Bytes = (payload: string): number => {
  const padding = payload.length - payload.replace(/=+$/u, "").length;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};

/**
 * What reading a file gave, as the attachment it makes: ready with its data
 * URL, which names the chat type (a reader names whatever type the file
 * system guessed, which the server would refuse as a mismatch), or failed.
 * Too large once its bytes are counted is a refusal, not a failure.
 */
export const readAttachment = (
  attachment: ChatAttachment,
  readerResult: string | undefined,
): ChatAttachment | AttachmentRefusal => {
  const marker = ";base64,";
  const at = readerResult?.indexOf(marker) ?? -1;
  if (
    readerResult === undefined ||
    !readerResult.startsWith("data:") ||
    at === -1
  ) {
    return { ...attachment, state: { status: "failed" } };
  }
  const payload = readerResult.slice(at + marker.length);
  const size = base64Bytes(payload);
  if (size > CHAT_FILE_MAX_BYTES) {
    return "too-large";
  }
  return {
    ...attachment,
    size,
    state: {
      status: "ready",
      dataUrl: `data:${attachment.mimeType};base64,${payload}`,
    },
  };
};

/** Whether the composer may send: no file is still reading or failed. */
export const attachmentsSendable = (
  attachments: readonly ChatAttachment[],
): boolean =>
  attachments.every((attachment) => attachment.state.status === "ready");

/** A file ready to go, as the message sends it. */
export type ReadyFile = SentFile & { readonly dataUrl: string };

/** What the composer hands over to send: the text, and the files read for it. */
export type ChatDraft = {
  readonly text: string;
  readonly files: readonly ReadyFile[];
};

/** The files ready to send, in the order they were added. */
export const readyFiles = (
  attachments: readonly ChatAttachment[],
): readonly ReadyFile[] =>
  attachments.flatMap((attachment) =>
    attachment.state.status === "ready"
      ? [
          {
            name: attachment.name,
            mimeType: attachment.mimeType,
            dataUrl: attachment.state.dataUrl,
          },
        ]
      : [],
  );

/**
 * The message parts that carry `files`, as the web builds them: an image or
 * a document whose source is the file's data URL and whose metadata names
 * the file. The server scans and stores each one and keeps a reference to
 * the stored file in the message in its place.
 */
export const attachmentParts = (files: readonly ReadyFile[]) =>
  files.map((file) => ({
    type: file.mimeType.startsWith("image/") ? "image" : "document",
    source: { type: "url", value: file.dataUrl, mimeType: file.mimeType },
    metadata: { filename: file.name },
  }));

/** Why a message was refused: a file the server would not take, or anything else. */
export type SendRefusal = "failed" | "file-refused" | "file-not-anonymizable";

export const sendRefusal = (
  error: ApiError,
  withFiles: boolean,
): SendRefusal => {
  const status = error._tag === "ApiRequestError" ? error.status : undefined;
  if (!withFiles) {
    return "failed";
  }
  if (status === 422) {
    return "file-not-anonymizable";
  }
  return status === 400 || status === 413 ? "file-refused" : "failed";
};
