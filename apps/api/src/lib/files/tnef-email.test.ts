import { describe, expect, test } from "bun:test";

import {
  EML_MIME_TYPE,
  TNEF_MIME_TYPE,
} from "@stll/api-contract/email-mime-types";
import {
  FILE_PART_KINDS,
  parseFilePartId,
} from "@stll/api-contract/file-parts";

import { listEmbeddedParts } from "@/api/lib/files/embedded-part-worker";
import { tnefStream, wendlerMessage } from "@/api/tests/fixtures/tnef";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

import {
  buildEmailPreview,
  describeEmailAttachments,
  parsedEmailToText,
  parseEmail,
} from "./email-to-html";
import { readPartOfFile } from "./file-part";

const { message: WENDLER, draft: DRAFT } = await wendlerMessage();
const WINMAIL = tnefStream(WENDLER);

/** The MIME message Outlook sends: a text body, maybe, and `winmail.dat`. */
const outlookEml = ({
  text,
  winmail,
  winmailType = "application/ms-tnef",
  winmailName = "winmail.dat",
}: {
  text: string | null;
  winmail: Uint8Array;
  winmailType?: string;
  winmailName?: string;
}) =>
  new TextEncoder().encode(
    [
      "From: Dr. Katharina Wendler <k.wendler@wendler-rechtsanwaelte.de>",
      "To: Jonas Pfeiffer <j.pfeiffer@pfeiffer-hochbau.de>",
      `Subject: ${WENDLER.subject}`,
      "Date: Tue, 17 Nov 2026 09:42:00 +0100",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="OUTLOOK"',
      "",
      ...(text === null
        ? []
        : ["--OUTLOOK", "Content-Type: text/plain; charset=utf-8", "", text]),
      "--OUTLOOK",
      `Content-Type: ${winmailType}; name="${winmailName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${winmailName}"`,
      "",
      Buffer.from(winmail).toString("base64"),
      "--OUTLOOK--",
      "",
    ].join("\r\n"),
  );

const stored = (bytes: Uint8Array, fileName: string, mimeType: string) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    mimeType,
    path: fileName,
  });

const ATTACHMENT_NAMES = WENDLER.attachments.map(({ fileName }) => fileName);
const EXHIBITS_NAME = ATTACHMENT_NAMES.at(1) ?? "";

/** What an email's preview lists, and what each part opens as. */
const listedAndRead = async (
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
) => {
  const parsed = (
    await parseEmail(new Uint8Array(bytes).buffer, mimeType)
  ).unwrap();
  const listed = await describeEmailAttachments(
    parsed,
    buildEmailPreview(parsed).attachments,
  );
  const source = stored(bytes, fileName, mimeType);
  const read = await Promise.all(
    listed.map(async ({ part }) => {
      const address = parseFilePartId(part);
      return address === null
        ? null
        : (await readPartOfFile(source, address, "ibm437")).unwrap();
    }),
  );
  return { parsed, listed, read };
};

describe("a TNEF attachment of an email", () => {
  test("is replaced by the files it carries, which open under their own names", async () => {
    const { parsed, listed, read } = await listedAndRead(
      outlookEml({ text: null, winmail: WINMAIL }),
      "Klageerwiderung.eml",
      EML_MIME_TYPE,
    );
    expect(listed.map(({ fileName }) => fileName)).toEqual(ATTACHMENT_NAMES);
    expect(listed.map(({ mediaType }) => mediaType)).toEqual([
      "application/pdf",
      "text/plain",
    ]);
    expect(
      read.map((part) => ({
        fileName: part?.fileName,
        size: part?.bytes.byteLength,
      })),
    ).toEqual(
      listed.map(({ fileName, sizeBytes }) => ({
        fileName: fileName ?? undefined,
        size: sizeBytes,
      })),
    );
    expect(read[0]?.bytes.byteLength).toBe(DRAFT.byteLength);
    // Without a body of its own, the email shows the one TNEF carries.
    expect(parsed.body).toEqual({
      type: "html",
      html: expect.stringContaining("<p>Sehr geehrter Herr Pfeiffer,</p>"),
    });
  });

  test("leaves the email's own body as it is", async () => {
    const parsed = (
      await parseEmail(
        new Uint8Array(
          outlookEml({ text: "Guten Tag, siehe Anhang.", winmail: WINMAIL }),
        ).buffer,
        EML_MIME_TYPE,
      )
    ).unwrap();
    expect(parsed.body).toEqual({
      type: "text",
      text: expect.stringContaining("Guten Tag, siehe Anhang."),
    });
    expect(parsed.attachments.map(({ fileName }) => fileName)).toEqual(
      ATTACHMENT_NAMES,
    );
  });

  test("that does not read stays an attachment, as does a stream not declared as TNEF", async () => {
    const cases = [
      {
        // Cut inside an attribute, so the stream does not read.
        winmail: WINMAIL.slice(0, 45),
        winmailType: "application/ms-tnef",
        winmailName: "winmail.dat",
        expected: ["winmail.dat"],
      },
      {
        winmail: WINMAIL,
        winmailType: "application/octet-stream",
        winmailName: "zaloha.bin",
        expected: ["zaloha.bin"],
      },
      // Its name alone declares it, as Outlook's own name.
      {
        winmail: WINMAIL,
        winmailType: "application/octet-stream",
        winmailName: "WINMAIL.DAT",
        expected: ATTACHMENT_NAMES,
      },
    ];
    for (const { expected, ...attachment } of cases) {
      const parsed = (
        await parseEmail(
          new Uint8Array(outlookEml({ text: "Anbei.", ...attachment })).buffer,
          EML_MIME_TYPE,
        )
      ).unwrap();
      expect(parsed.attachments.map(({ fileName }) => fileName)).toEqual(
        expected,
      );
    }
  });

  test("feeds search and AI the text of the message it carries", async () => {
    const parsed = (
      await parseEmail(
        new Uint8Array(outlookEml({ text: null, winmail: WINMAIL })).buffer,
        EML_MIME_TYPE,
      )
    ).unwrap();
    expect(parsedEmailToText(parsed)).toContain(
      "anbei der Entwurf der Klageerwiderung für die mündliche Verhandlung",
    );
  });
});

describe("a TNEF stream on its own", () => {
  test("reads as the email it is, its files opening by their positions", async () => {
    const { parsed, listed, read } = await listedAndRead(
      WINMAIL,
      "winmail.dat",
      TNEF_MIME_TYPE,
    );
    expect(parsed).toMatchObject({
      subject: WENDLER.subject,
      from: expect.stringContaining("k.wendler@wendler-rechtsanwaelte.de"),
      to: [expect.stringContaining("j.pfeiffer@pfeiffer-hochbau.de")],
      cc: [expect.stringContaining("l.brandstetter@wendler-rechtsanwaelte.de")],
    });
    expect(listed.map(({ fileName }) => fileName)).toEqual(ATTACHMENT_NAMES);
    expect(read.map((part) => part?.fileName)).toEqual(ATTACHMENT_NAMES);
  });

  test("stored under its name with no media type, opens as TNEF", async () => {
    const source = stored(WINMAIL, "WINMAIL.DAT", "application/octet-stream");
    const read = await readPartOfFile(
      source,
      {
        kind: FILE_PART_KINDS.attachment,
        index: 1,
      },
      "ibm437",
    );
    expect(read.unwrap().fileName).toBe(EXHIBITS_NAME);
  });

  test("an attached message lists its own files, each opening by its path", async () => {
    const inner = tnefStream({
      ...WENDLER,
      subject: "AW: Abnahmeprotokoll Bauabschnitt 2",
      attachments: WENDLER.attachments.slice(1),
    });
    const outer = tnefStream({
      ...WENDLER,
      attachments: WENDLER.attachments.slice(0, 1),
      attachedMessage: {
        name: "AW: Abnahmeprotokoll Bauabschnitt 2",
        tnef: inner,
      },
    });
    const within = { kind: FILE_PART_KINDS.attachment, index: 1 } as const;
    const files = (
      await listEmbeddedParts({
        fileBytes: outer,
        containerMimeType: TNEF_MIME_TYPE,
        containerName: "winmail.dat",
        zipNameCodePage: "ibm437",
        part: within,
      })
    ).unwrap();
    expect(files?.map(({ fileName }) => fileName)).toEqual(
      WENDLER.attachments.slice(1).map(({ fileName }) => fileName),
    );
    const part = parseFilePartId(files?.at(0)?.part?.part ?? "");
    expect(part?.within).toEqual(within);
    const read = await readPartOfFile(
      stored(outer, "winmail.dat", TNEF_MIME_TYPE),
      part ?? within,
      "ibm437",
    );
    expect(read.unwrap().fileName).toBe(EXHIBITS_NAME);
  });
});
