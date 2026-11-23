import { describe, expect, test } from "bun:test";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import { encodeText } from "@stll/mojibake/charsets";

import {
  mailboxWithLargeMessage,
  mailMessage,
  MATTER_CORRESPONDENCE,
  writeMbox,
} from "@/api/tests/fixtures/mbox";

import {
  mailboxEntry,
  mailboxMessageFileName,
  mailboxMessageRow,
} from "./mailbox-messages";
import { MBOX_MESSAGE_MAX_BYTES, scanMbox } from "./mbox";

const MAILBOX_NAME = "spis-23-C-118-2026.mbox";

const rowsOf = async (bytes: Uint8Array) =>
  await Promise.all(
    scanMbox(bytes).messages.map(
      async (message) =>
        await mailboxEntry(message, MAILBOX_NAME).then(mailboxMessageRow),
    ),
  );

describe("a mailbox's list", () => {
  test("shows what each header states and opens each message as an email", async () => {
    const { bytes } = writeMbox(
      MATTER_CORRESPONDENCE.map((message) => mailMessage(message)),
      "mboxrd",
    );
    const rows = await rowsOf(bytes);
    expect(rows).toEqual([
      {
        subject: "Spis 23 C 118/2026, podklady k jednání",
        from: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
        date: "2026-11-17T08:30:00.000Z",
        folder: null,
        fileName: "Spis 23 C 118_2026, podklady k jednání.eml",
        sizeBytes: expect.any(Number),
        part: {
          part: "message:0",
          fileName: "Spis 23 C 118_2026, podklady k jednání.eml",
          mediaType: EML_MIME_TYPE,
          sizeBytes: expect.any(Number),
        },
        unavailable: null,
      },
      expect.objectContaining({
        subject: "Re: Spis 23 C 118/2026, podklady k jednání",
        // Gmail's export writes the labels a message carries.
        folder: "Spisy/23 C 118-2026,Důležité",
        part: expect.objectContaining({ part: "message:1" }),
      }),
      expect.objectContaining({
        // An encoded subject reads as its text.
        subject: "Vyjádření k žalobě",
        folder: "Spisy/Stavby Hradec",
        fileName: "Vyjádření k žalobě.eml",
      }),
    ]);
    // The list never holds a body.
    expect(JSON.stringify(rows)).not.toContain("posílám podklady");
  });

  test("a raw 8-bit folder header reads in the charset its program wrote", async () => {
    // Outlook Express and older Thunderbird exports write the folder name
    // unencoded, in the system's code page.
    const message = encodeText(
      [
        "From: Kalina <kalina@ak-kalina-vesela.cz>",
        "To: podatelna@ak-kalina-vesela.cz",
        "Subject: Podklady k jednani",
        "X-Folder: Došlá pošta/Spisy 2026",
        "Date: Tue, 17 Nov 2026 09:30:00 +0100",
        "",
        "Dobrý den, v příloze zasíláme podklady.",
        "",
      ].join("\n"),
      "windows-1250",
    );
    if (message === null) {
      throw new Error("the message is writable in windows-1250");
    }
    const { bytes } = writeMbox([message], "mboxrd");
    const [row] = await rowsOf(bytes);
    expect(row).toMatchObject({
      subject: "Podklady k jednani",
      folder: "Došlá pošta/Spisy 2026",
    });
  });

  test("a message without a subject or date is named after the mailbox", async () => {
    const { bytes } = writeMbox(
      [
        mailMessage({
          ...MATTER_CORRESPONDENCE[0]!,
          subject: null,
          date: null,
        }),
      ],
      "mboxo",
    );
    const [row] = await rowsOf(bytes);
    expect(row).toMatchObject({
      subject: null,
      date: null,
      fileName: "spis-23-C-118-2026-1.eml",
      part: { part: "message:0", fileName: "spis-23-C-118-2026-1.eml" },
    });
  });

  test("a message over the size bound and a damaged one are listed with why", async () => {
    const damaged = mailboxWithLargeMessage(
      MBOX_MESSAGE_MAX_BYTES + 1024 * 1024,
      new TextEncoder().encode(
        "From kalina@ak-kalina-vesela.cz Tue Nov 17 09:30:00 2026\n\u0000\u0001\u0002 poškozená data\n",
      ),
    );
    const rows = await rowsOf(damaged);
    expect(rows).toMatchObject([
      {
        subject: "Spis 23 C 118/2026, podklady k jednání",
        part: null,
        unavailable: "tooLarge",
      },
      { part: null, unavailable: "unreadable" },
    ]);
    expect(rows[0]?.sizeBytes).toBeGreaterThan(MBOX_MESSAGE_MAX_BYTES);
  });
});

describe("a message's file name", () => {
  test.each([
    ["Re: Spis 23 C 118/2026", "Re_ Spis 23 C 118_2026.eml"],
    ["  Výzva\t k  úhradě ", "Výzva k úhradě.eml"],
    ["", "korespondence-3.eml"],
    [null, "korespondence-3.eml"],
  ])("%j is %j", (subject, name) => {
    expect(mailboxMessageFileName(subject, "korespondence.MBOX", 2)).toBe(name);
  });

  test("a long subject is cut, keeping the extension", () => {
    const name = mailboxMessageFileName("Smír ".repeat(200), "a.mbox", 0);
    expect(name.endsWith(".eml")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(124);
  });
});
