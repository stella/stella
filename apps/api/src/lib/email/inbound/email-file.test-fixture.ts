/**
 * One stated message rendered as an RFC 5322 file and as an Outlook .msg
 * file, so tests can compare what each format normalizes to.
 */
import {
  buildOutlookMessage,
  toArrayBuffer,
} from "@/api/lib/files/outlook-msg.test-fixture";

import type { EmailFileFormat } from "./message";

export type StatedMessage = {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  sentAt: Date;
  messageId: string;
  inReplyTo?: string | undefined;
  text: string;
  attachments: readonly {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
  }[];
};

const BOUNDARY = "stella-boundary";

const BASE64_LINE_LENGTH = 76;

const base64Lines = (bytes: Uint8Array) => {
  const encoded = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let start = 0; start < encoded.length; start += BASE64_LINE_LENGTH) {
    lines.push(encoded.slice(start, start + BASE64_LINE_LENGTH));
  }
  return lines.join("\r\n");
};

const htmlBody = (text: string) => `<p>${text}</p>`;

/** The RFC 5322 rendering of a stated message, with text and HTML parts. */
export const emlBytes = (message: StatedMessage): Uint8Array => {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to.join(", ")}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.join(", ")}`] : []),
    `Subject: ${message.subject}`,
    `Date: ${message.sentAt.toUTCString()}`,
    `Message-ID: ${message.messageId}`,
    ...(message.inReplyTo === undefined
      ? []
      : [`In-Reply-To: ${message.inReplyTo}`]),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
  ];
  const parts = [
    [
      `--${BOUNDARY}`,
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain; charset=utf-8",
      "",
      message.text,
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "",
      htmlBody(message.text),
      "--alt--",
    ].join("\r\n"),
    ...message.attachments.map(({ fileName, mimeType, bytes }) =>
      [
        `--${BOUNDARY}`,
        `Content-Type: ${mimeType}; name="${fileName}"`,
        `Content-Disposition: attachment; filename="${fileName}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(bytes),
      ].join("\r\n"),
    ),
  ];
  return new TextEncoder().encode(
    `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${BOUNDARY}--\r\n`,
  );
};

export const emlFile = (message: StatedMessage): ArrayBuffer =>
  toArrayBuffer(emlBytes(message));

/** The Outlook .msg rendering of the same stated message. */
export const msgFile = (message: StatedMessage): ArrayBuffer =>
  buildOutlookMessage({
    subject: message.subject,
    fromEmail: message.from,
    submittedAt: message.sentAt.toISOString(),
    messageId: message.messageId,
    ...(message.inReplyTo === undefined
      ? {}
      : { inReplyTo: message.inReplyTo }),
    text: message.text,
    html: htmlBody(message.text),
    recipients: [
      ...message.to.map((email) => ({ email, type: "to" as const })),
      ...message.cc.map((email) => ({ email, type: "cc" as const })),
    ],
    attachments: message.attachments,
  });

export const EMAIL_FILE_RENDERINGS = {
  eml: emlFile,
  msg: msgFile,
} as const satisfies Record<
  EmailFileFormat,
  (message: StatedMessage) => ArrayBuffer
>;

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n% offer\n");

/** A reply with a PDF attachment, as an Outlook user would file it. */
export const GOLDEN_MESSAGE = {
  subject: "Settlement offer",
  from: "Jane.Lawyer@Example.com",
  to: ["client@example.org"],
  cc: ["copy@example.org"],
  sentAt: new Date("2026-06-02T10:00:00Z"),
  messageId: "<offer@Example.COM>",
  inReplyTo: "<request@example.org>",
  text: "Please find the offer attached.",
  attachments: [
    { fileName: "offer.pdf", mimeType: "application/pdf", bytes: PDF_BYTES },
  ],
} satisfies StatedMessage;
