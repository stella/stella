import { MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES } from "@stll/api-contract";

export const EMAIL_ATTACHMENT_RESPONSE_DISPOSITION = {
  download: "download",
  inline: "inline",
} as const;

type EmailAttachmentResponseDisposition =
  (typeof EMAIL_ATTACHMENT_RESPONSE_DISPOSITION)[keyof typeof EMAIL_ATTACHMENT_RESPONSE_DISPOSITION];

export const getEmailAttachmentResponseBytes = ({
  bytes,
  disposition,
  mimeType,
}: {
  bytes: Uint8Array;
  disposition: EmailAttachmentResponseDisposition;
  mimeType: string | null;
}): Uint8Array => {
  const normalizedMimeType =
    mimeType?.split(";").at(0)?.trim().toLowerCase() ?? "";
  if (
    disposition !== EMAIL_ATTACHMENT_RESPONSE_DISPOSITION.inline ||
    normalizedMimeType !== "text/plain" ||
    bytes.byteLength <= MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES
  ) {
    return bytes;
  }
  return bytes.subarray(0, MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES);
};
