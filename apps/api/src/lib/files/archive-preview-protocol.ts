import { ASIC_FILE_FORMATS } from "@stll/api-contract/asic-file-formats";
import { E_INVOICE_FILE_FORMATS } from "@stll/api-contract/e-invoice-formats";
import { ZIP_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";
import { SIGNED_DOSSIER_FORMATS } from "@stll/api-contract/signed-dossier-formats";
import { STRUCTURED_DOCUMENT_FORMATS } from "@stll/api-contract/structured-document-formats";

// Containers read whole into a worker, under one byte budget. An XML dossier
// carries its documents inline, so it is bounded like a ZIP.
const DOCUMENT_ARCHIVE_FORMATS = [
  ...ASIC_FILE_FORMATS,
  ...SIGNED_DOSSIER_FORMATS,
  ...STRUCTURED_DOCUMENT_FORMATS,
  ...E_INVOICE_FILE_FORMATS.filter(({ container }) => container === "zip"),
  ZIP_FILE_FORMAT,
];

export const isDocumentArchiveMimeType = (mimeType: string): boolean =>
  DOCUMENT_ARCHIVE_FORMATS.some((format) => format.mimeType === mimeType);

export const DOCUMENT_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

export const ASIC_PREVIEW_WORKER_MODE = "asic-preview";

export const ZIP_ARCHIVE_PREVIEW_MODE = "zip-archive-preview";

/**
 * A mailbox's text, read from the worker's input as it streams in: a
 * mailbox is never held whole, so it is not bounded like an archive.
 */
export const MAILBOX_TEXT_WORKER_MODE = "mailbox-text";

/**
 * An Outlook mailbox (`.pst`) streamed into the worker, which writes it to a
 * private temporary file and reads it at an offset: its list of messages,
 * one message as an email, or its text.
 */
export const PST_WORKER_MODE = {
  list: "pst-list",
  message: "pst-message",
  text: "pst-text",
} as const;

/**
 * A PST mode's arguments after its mode and character budget: the
 * mailbox's file name, the worker's timeout (its reading ends before it)
 * and, for one message, its position.
 */
export const pstWorkerArguments = ({
  mailboxName,
  timeoutMs,
  index = null,
}: {
  mailboxName: string;
  timeoutMs: number;
  index?: number | null;
}): string[] => [
  mailboxName,
  String(timeoutMs),
  ...(index === null ? [] : [String(index)]),
];

export const PST_WORKER_EXIT = {
  unreadable: 20,
  noMessage: 23,
  tooLarge: 24,
} as const;

export const STRUCTURED_DOCUMENT_PREVIEW_MODE = "structured-document-preview";

export const SIGNED_DOSSIER_WORKER_MODE = {
  preview: "signed-dossier-preview",
} as const;

export const ARCHIVE_PREVIEW_WORKER_EXIT = {
  unreadable: 20,
  rejected: 21,
} as const;
