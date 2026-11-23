import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import { FILE_PART_MAX_INDEX } from "@stll/api-contract/file-parts";
import { MAILBOX_MAX_MESSAGES } from "@stll/api-contract/mailbox";

import {
  LAW_FIRM_MAILBOX_NAME,
  LAW_FIRM_MESSAGES,
  pstFixture,
} from "@/api/tests/fixtures/pst";

import { parseEmail } from "./email-to-html";
import { mailboxMessageRow } from "./mailbox-messages";
import { MBOX_MESSAGE_MAX_BYTES } from "./mbox";
import {
  PST_MAILBOX_LIMITS,
  pstBytesFile,
  readPstEntries,
  readPstMessage,
  readPstText,
  withPstFile,
} from "./pst-mailbox";

/** A deadline reading never reaches, and one it has passed. */
const LATER = () => Number.MAX_SAFE_INTEGER;
const PASSED = 0;

const lawFirm = () => pstBytesFile(pstFixture("law-firm.pst"), LATER());

const emailOf = async (index: number) => {
  const read = readPstMessage(lawFirm(), index, LAW_FIRM_MAILBOX_NAME);
  const { email } = read.unwrap();
  return (await parseEmail(email.slice().buffer, EML_MIME_TYPE)).unwrap();
};

describe("an Outlook mailbox", () => {
  test("is read under the bounds a mailbox is", () => {
    expect(PST_MAILBOX_LIMITS.maxMessages).toBe(MAILBOX_MAX_MESSAGES);
    expect(PST_MAILBOX_LIMITS.maxMessages).toBe(FILE_PART_MAX_INDEX + 1);
    expect(PST_MAILBOX_LIMITS.maxMessageBytes).toBe(MBOX_MESSAGE_MAX_BYTES);
    expect(PST_MAILBOX_LIMITS.maxMessageReadBytes).toBeGreaterThan(
      MBOX_MESSAGE_MAX_BYTES,
    );
  });

  test("lists its messages folder by folder, each opening as an email", () => {
    const { entries, truncated } = readPstEntries(
      lawFirm(),
      LAW_FIRM_MAILBOX_NAME,
    ).unwrap();
    expect(truncated).toBe(false);
    expect(
      entries.map(({ folder, subject, fileName }) => ({
        folder,
        subject,
        fileName,
      })),
    ).toEqual([...LAW_FIRM_MESSAGES]);
    const [first] = entries.map(mailboxMessageRow);
    expect(first).toMatchObject({
      from: "Petra Vlková",
      date: "Mon, 04 Mar 2024 09:00:00 +0000",
      part: {
        part: "message:0",
        mediaType: EML_MIME_TYPE,
        fileName: LAW_FIRM_MESSAGES[0].fileName,
      },
      unavailable: null,
    });
  });

  test("lists a message over the bound as too large, never reading it", () => {
    const { entries } = readPstEntries(
      lawFirm(),
      LAW_FIRM_MAILBOX_NAME,
    ).unwrap();
    const oversize = entries[6];
    expect(oversize?.length).toBe(48 * 1024 * 1024);
    expect(oversize && mailboxMessageRow(oversize)).toMatchObject({
      part: null,
      unavailable: "tooLarge",
    });
    const read = readPstMessage(lawFirm(), 6, LAW_FIRM_MAILBOX_NAME);
    expect(read.isErr() && read.error).toEqual({ type: "tooLarge" });
  });

  test("opens a message as the email it was, with its attachments", async () => {
    const email = await emailOf(0);
    expect(email).toMatchObject({
      subject: "Smlouva o převodu podílu: návrh k připomínkám",
      from: "Petra Vlková <petra.vlkova@vlkova-lisy.example>",
      to: ["Ondřej Lisý <ondrej.lisy@vlkova-lisy.example>"],
      cc: ["Jitka Fiktivní <jitka@fiktivni-stavby.example>"],
    });
    expect(email.body.type === "html" ? email.body.html : "").toContain(
      "<b>návrh smlouvy</b>",
    );
    expect(
      email.attachments.map(({ fileName, mimeType }) => [fileName, mimeType]),
    ).toEqual([
      ["navrh-smlouvy.pdf", "application/pdf"],
      ["poznámky k návrhu.txt", "application/octet-stream"],
    ]);
  });

  test("opens RTF bodies, a message without a subject and an attached message", async () => {
    const minutes = await emailOf(3);
    expect(minutes.body.type === "html" ? minutes.body.html : "").toContain(
      "Zápis z porady",
    );
    expect((await emailOf(4)).body).toEqual({
      type: "text",
      text: "Plnou moc jsem nechal podepsat u klientky.",
    });
    expect((await emailOf(2)).subject).toBeNull();
    // The attached message's content is not read; it is listed by name.
    const forwarded = await emailOf(5);
    expect(
      forwarded.attachments.map(({ fileName, bytes }) => [
        fileName,
        bytes.byteLength,
      ]),
    ).toEqual([["Výzva k úhradě.eml", 0]]);
  });

  test("refuses a position past its messages and bytes that are not a mailbox", () => {
    const past = readPstMessage(lawFirm(), 9, LAW_FIRM_MAILBOX_NAME);
    expect(past.isErr() && past.error).toEqual({ type: "noMessage" });
    const damaged = pstFixture("law-firm.pst").slice(0, 4096);
    const read = readPstEntries(
      pstBytesFile(damaged, LATER()),
      LAW_FIRM_MAILBOX_NAME,
    );
    expect(read.isErr() && read.error._tag).toBe("PstReadError");
    const empty = readPstEntries(
      pstBytesFile(pstFixture("outlook-pst-rs/Empty.pst"), LATER()),
      "Empty.pst",
    ).unwrap();
    expect(empty).toEqual({ entries: [], truncated: false });
  });

  test("stops at its deadline", () => {
    const read = readPstEntries(
      pstBytesFile(pstFixture("law-firm.pst"), PASSED),
      LAW_FIRM_MAILBOX_NAME,
    );
    expect(read.isErr() && read.error.reason).toBe("stopped");
  });

  test("its text gives each message's header, body and attachments, within the budget", async () => {
    const text = (
      await readPstText({
        open: (deadline) => pstBytesFile(pstFixture("law-firm.pst"), deadline),
        maxChars: 100_000,
        mailboxName: LAW_FIRM_MAILBOX_NAME,
        deadline: LATER(),
      })
    ).unwrap();
    expect(text).toStartWith("Mailbox.\n\nMessage 1 (folder: Doručená pošta)");
    expect(text).toContain("Subject: Smlouva o převodu podílu");
    expect(text).toContain(
      "Attachments: navrh-smlouvy.pdf, poznámky k návrhu.txt",
    );
    expect(text).toContain(
      "Message 6 (folder: Doručená pošta/Klienti/Fiktivní stavby)",
    );
    expect(text).toContain("Attachments: Výzva k úhradě.eml");
    expect(text).toContain(
      "Subject: Spis ve skenech\nThe message is too large to read.",
    );
    expect(text).toContain("Message 9 (folder: Archiv/2023)");
    const short = (
      await readPstText({
        open: (deadline) => pstBytesFile(pstFixture("law-firm.pst"), deadline),
        maxChars: 120,
        mailboxName: LAW_FIRM_MAILBOX_NAME,
        deadline: LATER(),
      })
    ).unwrap();
    expect(short).toHaveLength(120);
  });

  test("a stored mailbox is read from a private file that has no name on disk", async () => {
    const bytes = pstFixture("law-firm.pst");
    const before = readdirSync(tmpdir()).filter((name) =>
      name.startsWith("stella-pst-"),
    );
    const listed = await withPstFile(
      (async function* () {
        yield bytes.subarray(0, 1000);
        yield bytes.subarray(1000);
      })(),
      bytes.byteLength,
      async (open) => {
        // Already while it is read, nothing of it is left on disk: a worker
        // killed now leaves nothing behind.
        expect(
          readdirSync(tmpdir()).filter((name) =>
            name.startsWith("stella-pst-"),
          ),
        ).toEqual(before);
        return await Promise.resolve(
          readPstEntries(open(LATER()), LAW_FIRM_MAILBOX_NAME),
        );
      },
    );
    expect(listed.unwrap().unwrap().entries).toHaveLength(9);
    const tooLarge = await withPstFile(
      (async function* () {
        yield bytes;
      })(),
      bytes.byteLength - 1,
      async () => await Promise.resolve(0),
    );
    expect(tooLarge.isErr()).toBe(true);
    expect(
      readdirSync(tmpdir()).filter((name) => name.startsWith("stella-pst-")),
    ).toEqual(before);
  });
});
