import { describe, expect, test } from "bun:test";

import { extractFileText, resolveExtractionMimeType } from "./extract-content";

const toArrayBuffer = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
};

describe("resolveExtractionMimeType", () => {
  test("recovers email MIME types from generic stored files", () => {
    expect(
      resolveExtractionMimeType({
        fileName: "thread.eml",
        mimeType: "application/octet-stream",
      }),
    ).toBe("message/rfc822");
    expect(
      resolveExtractionMimeType({
        fileName: "mail.msg",
        mimeType: "application/octet-stream",
      }),
    ).toBe("application/vnd.ms-outlook");
  });

  test("recovers direct text MIME types from generic stored files", () => {
    expect(
      resolveExtractionMimeType({
        fileName: "notes.md",
        mimeType: "application/octet-stream",
      }),
    ).toBe("text/markdown");
    expect(
      resolveExtractionMimeType({
        fileName: "invite.ics",
        mimeType: "application/octet-stream",
      }),
    ).toBe("text/calendar");
  });
});

describe("extractFileText", () => {
  test("extracts direct text files", async () => {
    const text = await extractFileText(
      toArrayBuffer("hello\nworld"),
      "text/plain",
    );

    expect(text).toBe("hello\nworld");
  });

  test("extracts email headers, body, and supported attachment text", async () => {
    const email = [
      "From: Jane Lawyer <jane@example.com>",
      "To: client@example.org",
      "Subject: Contract draft",
      "Date: Mon, 02 Jun 2026 10:00:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="BND"',
      "",
      "--BND",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Email body text.",
      "--BND",
      "Content-Type: text/plain; charset=utf-8",
      'Content-Disposition: attachment; filename="notes.txt"',
      "",
      "Attachment text.",
      "--BND--",
      "",
    ].join("\r\n");

    const text = await extractFileText(toArrayBuffer(email), "message/rfc822");

    expect(text).toContain("From: Jane Lawyer <jane@example.com>");
    expect(text).toContain("To: client@example.org");
    expect(text).toContain("Subject: Contract draft");
    expect(text).toContain("Email body text.");
    expect(text).toContain("Attachment: notes.txt (text/plain)");
    expect(text).toContain("Attachment text.");
  });

  test("keeps email body when a supported attachment is malformed", async () => {
    const email = [
      "From: Jane Lawyer <jane@example.com>",
      "To: client@example.org",
      "Subject: Contract draft",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="BND"',
      "",
      "--BND",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Email body survives.",
      "--BND",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="broken.pdf"',
      "",
      "not a pdf",
      "--BND--",
      "",
    ].join("\r\n");

    const text = await extractFileText(toArrayBuffer(email), "message/rfc822");

    expect(text).toContain("Subject: Contract draft");
    expect(text).toContain("Email body survives.");
    expect(text).not.toContain("Attachment: broken.pdf");
  });
});
