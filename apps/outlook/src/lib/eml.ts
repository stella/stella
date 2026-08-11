import { createMimeMessage } from "mimetext/browser";

import type {
  AttachmentDownloadResult,
  MailAddress,
  MailSnapshot,
} from "@/types";

const FALLBACK_SENDER = "unknown@stella.local";
const BASE64_CHUNK_SIZE = 0x80_00;

const toMailbox = (address: MailAddress) =>
  address.name
    ? { addr: address.email, name: address.name }
    : { addr: address.email };

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCodePoint(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE),
    );
  }
  return btoa(binary);
};

const emlFileName = (subject: string): string => {
  const base = subject
    .replace(/[^\p{L}\p{N}\-_. ]/gu, "_")
    .trim()
    .slice(0, 200);
  return `${base || "email"}.eml`;
};

/**
 * Reconstruct the selected Outlook message as a single RFC822 `.eml`
 * file from the snapshot plus its already-downloaded attachments. The
 * stella API parses this server-side (the same pipeline that ingests
 * dropped `.eml`/`.msg` files), so the message and each attachment land
 * as real matter entities with HTML preview and search — no client-side
 * field mapping. Office exposes no MIME for the selected item itself, so
 * the message is rebuilt here rather than fetched; only the message the
 * user chose to save leaves the mailbox.
 */
export const buildEmlFile = async ({
  snapshot,
  attachments,
}: {
  snapshot: MailSnapshot;
  attachments: AttachmentDownloadResult[];
}): Promise<File> => {
  const message = createMimeMessage();

  const sender = snapshot.from ?? null;
  message.setSender(
    sender
      ? toMailbox(sender)
      : { addr: snapshot.userEmail ?? FALLBACK_SENDER },
  );

  if (snapshot.to.length > 0) {
    message.setRecipients(snapshot.to.map(toMailbox), { type: "To" });
  }
  if (snapshot.cc.length > 0) {
    message.setRecipients(snapshot.cc.map(toMailbox), { type: "Cc" });
  }
  if (snapshot.bcc.length > 0) {
    message.setRecipients(snapshot.bcc.map(toMailbox), { type: "Bcc" });
  }

  message.setSubject(snapshot.subject || "(No subject)");
  if (snapshot.sentAt) {
    message.setHeader("Date", new Date(snapshot.sentAt).toUTCString());
  }
  if (snapshot.internetMessageId) {
    message.setHeader("Message-ID", snapshot.internetMessageId);
  }

  message.addMessage({ contentType: "text/plain", data: snapshot.bodyText });

  const encodedAttachments = await Promise.all(
    attachments
      .filter((attachment) => attachment.type === "downloaded")
      .map(async ({ file }) => ({
        data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        file,
      })),
  );

  for (const { data, file } of encodedAttachments) {
    message.addAttachment({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      encoding: "base64",
      data,
    });
  }

  return new File([message.asRaw()], emlFileName(snapshot.subject), {
    type: "message/rfc822",
  });
};
