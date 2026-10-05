import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  buildOutlookMessage,
  toArrayBuffer,
} from "@/api/lib/files/outlook-msg.test-fixture";

import {
  EMAIL_FILE_RENDERINGS,
  emlBytes,
  emlFile,
  GOLDEN_MESSAGE,
  msgFile,
  type StatedMessage,
} from "./email-file.test-fixture";
import { INBOUND_MAIL_LIMITS } from "./limits";
import {
  EMAIL_FILE_FORMATS,
  parseEmailFile,
  parseInboundMessage,
} from "./message";

const parseBoth = async (message: StatedMessage) => ({
  eml: await parseEmailFile({ bytes: emlFile(message), format: "eml" }),
  msg: await parseEmailFile({ bytes: msgFile(message), format: "msg" }),
});

describe("email file normalization", () => {
  test("an Outlook file and its RFC 5322 twin normalize to the same message", async () => {
    const { eml, msg } = await parseBoth(GOLDEN_MESSAGE);
    if (eml.isErr() || msg.isErr()) {
      throw new Error("expected both renderings to parse");
    }
    expect(msg.value).toEqual(eml.value);
    expect(eml.value).toMatchObject({
      from: "jane.lawyer@example.com",
      to: ["client@example.org"],
      cc: ["copy@example.org"],
      date: "2026-06-02T10:00:00.000Z",
      subject: "Settlement offer",
      text: "Please find the offer attached.",
      messageId: "<offer@example.com>",
      inReplyTo: "<request@example.org>",
      references: [],
    });
    expect(eml.value.attachments).toHaveLength(1);
    expect(eml.value.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("a file holding a forward stays one message under its own sender", async () => {
    const forward = {
      ...GOLDEN_MESSAGE,
      subject: "Fwd: Settlement offer",
      inReplyTo: undefined,
      text: [
        "See below.",
        "",
        "---------- Forwarded message ---------",
        "From: Judge <judge@court.example>",
        "Date: Mon, 1 Jun 2026 09:00:00 +0000",
        "Subject: Order",
        "To: Jane <jane.lawyer@example.com>",
        "",
        "Order text.",
      ].join("\r\n"),
    };
    const parsed = await parseEmailFile({
      bytes: emlFile(forward),
      format: "eml",
    });
    expect(parsed.isOk() && parsed.value.from).toBe("jane.lawyer@example.com");
    expect(parsed.isOk() && parsed.value.subject).toBe("Fwd: Settlement offer");
  });

  test.each([...EMAIL_FILE_FORMATS])(
    "rejects a %s file above the raw inbound limit before parsing",
    async (format) => {
      const parsed = await parseEmailFile({
        bytes: new ArrayBuffer(INBOUND_MAIL_LIMITS.rawBytes + 1),
        format,
      });
      expect(parsed.isErr() && parsed.error.reason).toBe("rawTooLarge");
    },
  );

  test("reports an unreadable Outlook container as malformed", async () => {
    const parsed = await parseEmailFile({
      bytes: toArrayBuffer(new TextEncoder().encode("not a compound file")),
      format: "msg",
    });
    expect(parsed.isErr() && parsed.error.reason).toBe("invalidMime");
  });

  test("an Outlook sender without an SMTP address is malformed like a bad From", async () => {
    const parsed = await parseEmailFile({
      bytes: buildOutlookMessage({
        subject: "Internal",
        fromEmail: "/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=JANE",
        text: "Hello",
      }),
      format: "msg",
    });
    expect(parsed.isErr() && parsed.error.reason).toBe("invalidFrom");
  });

  test("an Outlook file without a sender keeps a null sender", async () => {
    const parsed = await parseEmailFile({
      bytes: buildOutlookMessage({ subject: "Draft", text: "Unsent" }),
      format: "msg",
    });
    expect(parsed.isOk() && parsed.value.from).toBeNull();
  });
});

const mailbox = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,8}$/u),
    fc.constantFrom("example.com", "example.org", "Court.Example"),
  )
  .map(([local, domain]) => `${local}@${domain}`);

const statedMessage = fc.record({
  subject: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ,.:-]{0,40}$/u),
  from: mailbox,
  to: fc.uniqueArray(mailbox, {
    minLength: 1,
    maxLength: 4,
    comparator: (a, b) => a.toLowerCase() === b.toLowerCase(),
  }),
  cc: fc.uniqueArray(mailbox, {
    maxLength: 3,
    comparator: (a, b) => a.toLowerCase() === b.toLowerCase(),
  }),
  sentAt: fc
    .integer({ min: 946_684_800, max: 4_102_444_799 })
    .map((seconds) => new Date(seconds * 1000)),
  messageId: fc
    .stringMatching(/^[a-z0-9]{1,12}$/u)
    .map((id) => `<${id}@example.com>`),
  text: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ,.]{0,200}$/u),
  attachments: fc.constant([]),
});

describe("attachment policy by source", () => {
  const blocked = [
    {
      label: "a blocked attachment type",
      attachment: {
        fileName: "invoice.html",
        mimeType: "text/html",
        bytes: new TextEncoder().encode("<p>Invoice</p>"),
      },
    },
    {
      label: "executable content under a harmless name",
      attachment: {
        fileName: "notes.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("MZ executable"),
      },
    },
  ];

  test.each(blocked)(
    "a delivery with $label is refused, since it would store the attachment",
    async ({ attachment }) => {
      const parsed = await parseInboundMessage(
        emlBytes({ ...GOLDEN_MESSAGE, attachments: [attachment] }),
      );
      expect(parsed.isErr() && parsed.error.reason).toBe("unsafeAttachment");
    },
  );

  test.each(blocked)(
    "an uploaded file with $label keeps the attachment inside the file",
    async ({ attachment }) => {
      for (const format of EMAIL_FILE_FORMATS) {
        const parsed = await parseEmailFile({
          bytes: EMAIL_FILE_RENDERINGS[format]({
            ...GOLDEN_MESSAGE,
            attachments: [attachment],
          }),
          format,
        });
        expect(parsed.isOk() && parsed.value.attachments).toHaveLength(1);
      }
    },
  );

  test("both sources still bound attachment size", async () => {
    const attachment = {
      fileName: "large.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array(INBOUND_MAIL_LIMITS.attachmentBytes + 1),
    };
    const delivered = await parseInboundMessage(
      emlBytes({ ...GOLDEN_MESSAGE, attachments: [attachment] }),
    );
    const uploaded = await parseEmailFile({
      bytes: emlFile({ ...GOLDEN_MESSAGE, attachments: [attachment] }),
      format: "eml",
    });
    expect(delivered.isErr() && delivered.error.reason).toBe(
      "attachmentTooLarge",
    );
    expect(uploaded.isErr() && uploaded.error.reason).toBe(
      "attachmentTooLarge",
    );
  });
});

describe("email file normalization invariants", () => {
  test("both formats normalize the same stated fields to the same values", async () => {
    await assertProperty(
      "both formats normalize the same stated fields to the same values",
      fc.asyncProperty(statedMessage, async (message) => {
        const { eml, msg } = await parseBoth(message);
        if (eml.isErr() || msg.isErr()) {
          throw new Error("expected both renderings to parse");
        }
        expect(msg.value).toEqual(eml.value);
        expect(eml.value.from).toBe(message.from.toLowerCase());
        expect(eml.value.to).toEqual(
          message.to.map((address) => address.toLowerCase()),
        );
        expect(eml.value.date).toBe(message.sentAt.toISOString());
        expect(eml.value.subject).toBe(message.subject.trim());
        expect(eml.value.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      }),
      { numRuns: 40 },
    );
  });

  test("both formats enforce the attachment count limit", async () => {
    await assertProperty(
      "both formats enforce the attachment count limit",
      fc.asyncProperty(
        fc.integer({ min: 0, max: INBOUND_MAIL_LIMITS.attachmentCount + 3 }),
        fc.constantFrom(...EMAIL_FILE_FORMATS),
        async (count, format) => {
          const message = {
            ...GOLDEN_MESSAGE,
            attachments: Array.from({ length: count }, (_, index) => ({
              fileName: `note-${index}.txt`,
              mimeType: "text/plain",
              bytes: new TextEncoder().encode(`note ${index}`),
            })),
          };
          const parsed = await parseEmailFile({
            bytes: EMAIL_FILE_RENDERINGS[format](message),
            format,
          });
          if (count > INBOUND_MAIL_LIMITS.attachmentCount) {
            expect(parsed.isErr() && parsed.error.reason).toBe(
              "tooManyAttachments",
            );
            return;
          }
          expect(parsed.isOk() && parsed.value.attachments).toHaveLength(count);
        },
      ),
      { numRuns: 20 },
    );
  });

  test("both formats enforce the recipient limit", async () => {
    await assertProperty(
      "both formats enforce the recipient limit",
      fc.asyncProperty(
        fc.integer({
          min: INBOUND_MAIL_LIMITS.recipients - 2,
          max: INBOUND_MAIL_LIMITS.recipients + 3,
        }),
        fc.constantFrom(...EMAIL_FILE_FORMATS),
        async (count, format) => {
          const message = {
            ...GOLDEN_MESSAGE,
            to: Array.from(
              { length: count },
              (_, index) => `r${index}@example.org`,
            ),
            cc: [],
          };
          const parsed = await parseEmailFile({
            bytes: EMAIL_FILE_RENDERINGS[format](message),
            format,
          });
          if (count > INBOUND_MAIL_LIMITS.recipients) {
            expect(parsed.isErr() && parsed.error.reason).toBe(
              "tooManyRecipients",
            );
            return;
          }
          expect(parsed.isOk() && parsed.value.to).toHaveLength(count);
        },
      ),
      { numRuns: 12 },
    );
  });
});
