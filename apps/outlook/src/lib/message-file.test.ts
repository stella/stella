import { describe, expect, mock, test } from "bun:test";

import { readMessageFile } from "@/lib/message-file";
import type { MailSnapshot } from "@/types";

const snapshot: MailSnapshot = {
  attachments: [
    {
      contentType: "application/pdf",
      id: "attachment-1",
      isInline: false,
      name: "draft.pdf",
      size: 4,
    },
    {
      contentType: "image/png",
      id: "attachment-2",
      isInline: true,
      name: "logo.png",
      size: 4,
    },
  ],
  bcc: [],
  bodyHtml: "",
  bodyText: "Please review the attached draft.",
  cc: [],
  conversationId: null,
  from: { email: "client@example.com", name: "Client" },
  internetMessageId: "<msg-1@example.com>",
  itemId: "item-1",
  itemInstanceKey: "item-0",
  mode: "read",
  sentAt: "2026-06-13T09:00:00.000Z",
  subject: "SPA review",
  to: [{ email: "lawyer@firm.example", name: "Lawyer" }],
  userEmail: "lawyer@firm.example",
};

describe("readMessageFile", () => {
  test("files the mailbox's own MIME when Outlook provides it", async () => {
    const mime = new TextEncoder().encode(
      "Message-ID: <msg-1@example.com>\r\n",
    );
    const downloadAttachment = mock(async () => {
      throw new Error("not needed");
    });

    const message = await readMessageFile(snapshot, {
      downloadAttachment,
      readMime: async () => await Promise.resolve(mime),
    });

    expect(message.source).toBe("mailbox");
    expect(message.file.name).toBe("SPA review.eml");
    expect(message.file.type).toBe("message/rfc822");
    expect(new Uint8Array(await message.file.arrayBuffer())).toEqual(mime);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  test("rebuilds the message with its attachments otherwise", async () => {
    const message = await readMessageFile(snapshot, {
      downloadAttachment: async (attachment) =>
        await Promise.resolve(
          attachment.isInline
            ? {
                attachmentId: attachment.id,
                reason: `${attachment.name}: inline attachment skipped`,
                type: "skipped" as const,
              }
            : {
                attachmentId: attachment.id,
                file: new File(
                  [new Uint8Array([1, 2, 3, 4])],
                  attachment.name,
                  {
                    type: "application/pdf",
                  },
                ),
                type: "downloaded" as const,
              },
        ),
      readMime: async () => await Promise.resolve(null),
    });

    expect(message.source).toBe("rebuilt");
    expect(message.skippedAttachments).toEqual([
      "logo.png: inline attachment skipped",
    ]);
    const raw = await message.file.text();
    expect(raw).toContain("Message-ID: <msg-1@example.com>");
    expect(raw).toContain('filename="draft.pdf"');
  });
});
