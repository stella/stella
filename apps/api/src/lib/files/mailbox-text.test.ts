import { describe, expect, test } from "bun:test";

import {
  mailboxWithLargeMessage,
  mailMessage,
  MATTER_CORRESPONDENCE,
  writeMbox,
} from "@/api/tests/fixtures/mbox";

import { readMailboxBytesText, readMailboxText } from "./mailbox-text";
import { MBOX_MESSAGE_MAX_BYTES } from "./mbox";

const withAttachments = mailMessage({
  ...MATTER_CORRESPONDENCE[0]!,
  subject: "Plná moc a výzva",
  body: "Dobrý den, v příloze posílám plnou moc.",
  attachments: [
    {
      fileName: "plna-moc.txt",
      mediaType: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode("Plná moc ze dne 2. 11. 2026"),
    },
    {
      fileName: "vyzva.eml",
      mediaType: "message/rfc822",
      bytes: mailMessage(MATTER_CORRESPONDENCE[1]!),
    },
  ],
});

const mailbox = writeMbox(
  [
    ...MATTER_CORRESPONDENCE.map((message) => mailMessage(message)),
    withAttachments,
  ],
  "mboxrd",
);

const read = async (bytes: Uint8Array, maxChars = 500_000) =>
  await readMailboxBytesText({
    bytes,
    maxChars,
    mailboxName: "spis.mbox",
  });

describe("a mailbox's text", () => {
  test("holds each message's header, body and attachments' names, in order", async () => {
    const text = (await read(mailbox.bytes)).unwrap();
    expect(text).toStartWith("Mailbox.");
    expect(text).toContain(
      "Message 1\nFrom: Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
    );
    expect(text).toContain("Subject: Spis 23 C 118/2026, podklady k jednání");
    // Unquoted as the message was written, its body decoded as it declares.
    expect(text).toContain("From the court's summons");
    expect(text).toContain("Dobrý den, paní Skořepová,");
    expect(text).toContain("Message 3 (folder: Spisy/Stavby Hradec)");
    expect(text).toContain("Subject: Vyjádření k žalobě");
    expect(text).toContain("Attachments: plna-moc.txt, vyzva.eml");
    expect(text.indexOf("Message 1")).toBeLessThan(text.indexOf("Message 4"));
    // Attachments are named, never read into the mailbox's text.
    expect(text).not.toContain("Plná moc ze dne");
  });

  test("keeps to the character budget", async () => {
    const text = (await read(mailbox.bytes, 120)).unwrap();
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toStartWith("Mailbox.\n\nMessage 1");
  });

  test("says which messages cannot be read", async () => {
    const bytes = mailboxWithLargeMessage(MBOX_MESSAGE_MAX_BYTES + 1024 * 1024);
    const text = (await read(bytes)).unwrap();
    expect(text).toContain("Subject: Spis 23 C 118/2026, podklady k jednání");
    expect(text).toContain("The message is too large to read.");
  });

  test("a file that is not a mailbox has no text", async () => {
    const result = await read(mailMessage(MATTER_CORRESPONDENCE[0]!));
    expect(result.isErr() && result.error._tag).toBe("MboxParseError");
  });

  test("a stream reads the same as the whole file, whatever its chunks", async () => {
    const whole = (await read(mailbox.bytes)).unwrap();
    const chunks = async function* () {
      for (let at = 0; at < mailbox.bytes.byteLength; at += 7) {
        await Promise.resolve();
        yield mailbox.bytes.subarray(at, at + 7);
      }
    };
    const streamed = await readMailboxText({
      chunks: chunks(),
      maxChars: 500_000,
      mailboxName: "spis.mbox",
    });
    expect(streamed.unwrap()).toBe(whole);
  });
});
