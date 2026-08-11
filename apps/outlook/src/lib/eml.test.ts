import { describe, expect, test } from "bun:test";

import { buildEmlFile } from "@/lib/eml";
import type { AttachmentDownloadResult, MailSnapshot } from "@/types";

const baseSnapshot: MailSnapshot = {
  attachments: [],
  bcc: [{ email: "blind@example.net", name: "Blind Recipient" }],
  bodyText: "Please review the attached draft before Friday.",
  cc: [{ email: "partner@firm.example", name: "Partner" }],
  conversationId: "conv-1",
  from: { email: "client@example.com", name: "Jane Client" },
  internetMessageId: "<msg-1@example.com>",
  itemInstanceKey: "item-instance-1",
  itemId: "item-1",
  mode: "read",
  sentAt: "2026-06-13T09:00:00.000Z",
  subject: "SPA review",
  to: [{ email: "lawyer@firm.example", name: "Lawyer" }],
  userEmail: "lawyer@firm.example",
};

const downloaded = (name: string, type: string): AttachmentDownloadResult => ({
  attachmentId: name,
  file: new File([new Uint8Array([1, 2, 3, 4])], name, { type }),
  type: "downloaded",
});

describe("buildEmlFile", () => {
  test("produces a message/rfc822 file with the header set", async () => {
    const file = await buildEmlFile({
      snapshot: baseSnapshot,
      attachments: [],
    });
    expect(file.type).toBe("message/rfc822");
    expect(file.name).toBe("SPA review.eml");

    const raw = await file.text();
    // mimetext RFC2047-encodes header words; the addresses, Message-ID,
    // and body stay readable and the server's parser decodes the rest.
    expect(raw).toContain("Subject:");
    expect(raw).toContain("client@example.com");
    expect(raw).toContain("lawyer@firm.example");
    expect(raw).toContain("partner@firm.example");
    expect(raw).toContain("blind@example.net");
    expect(raw).toContain("Message-ID: <msg-1@example.com>");
    expect(raw).toContain("Please review the attached draft before Friday.");
  });

  test("embeds downloaded attachments and skips inline/skipped ones", async () => {
    const file = await buildEmlFile({
      snapshot: baseSnapshot,
      attachments: [
        downloaded("invoice.pdf", "application/pdf"),
        { attachmentId: "logo", reason: "inline skipped", type: "skipped" },
      ],
    });

    const raw = await file.text();
    expect(raw).toContain("invoice.pdf");
    expect(raw.toLowerCase()).toContain("base64");
    expect(raw).not.toContain("logo");
  });

  test("falls back to the user address when there is no sender", async () => {
    const file = await buildEmlFile({
      snapshot: { ...baseSnapshot, from: null },
      attachments: [],
    });
    const raw = await file.text();
    expect(raw).toContain("lawyer@firm.example");
  });

  test("uses a safe filename when the subject is empty", async () => {
    const file = await buildEmlFile({
      snapshot: { ...baseSnapshot, subject: "" },
      attachments: [],
    });
    expect(file.name).toBe("email.eml");
  });
});
