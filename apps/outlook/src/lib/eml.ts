import { createMimeMessage } from "mimetext/browser";

import type {
  AttachmentDownloadResult,
  MailAddress,
  MailSnapshot,
} from "@/types";

const FALLBACK_SENDER = "unknown@sender.invalid";
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

export const emlFileName = (subject: string): string => {
  const base = subject
    .replace(/[^\p{L}\p{N}\-_. ]/gu, "_")
    .trim()
    .slice(0, 200);
  return `${base || "email"}.eml`;
};

/**
 * Rebuild the message as a single RFC 822 `.eml` file from the snapshot plus
 * its downloaded attachments. Used where Outlook cannot hand over the stored
 * MIME (compose drafts, hosts before Mailbox 1.14); the stored MIME is
 * preferred because it keeps every header and inline part. Only the message
 * the person chose to file leaves the mailbox.
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
  if (snapshot.bodyHtml.trim().length > 0) {
    message.addMessage({ contentType: "text/html", data: snapshot.bodyHtml });
  }

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
