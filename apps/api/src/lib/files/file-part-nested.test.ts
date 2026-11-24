import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import {
  FILE_PART_KINDS,
  FILE_PART_MAX_DEPTH,
  type FilePart,
  filePartId,
  parseFilePartId,
} from "@stll/api-contract/file-parts";
import { ZIP_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";

import { listEmbeddedParts } from "@/api/lib/files/embedded-part-worker";
import {
  mailMessage,
  MATTER_CORRESPONDENCE,
  writeMbox,
} from "@/api/tests/fixtures/mbox";
import { wrapP7m } from "@/api/tests/fixtures/p7m";
import { LAW_FIRM_MESSAGES, pstFixture } from "@/api/tests/fixtures/pst";
import { zfoFile } from "@/api/tests/fixtures/zfo";
import { makeZipArchive } from "@/api/tests/fixtures/zip-archive";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

import { readPartOfFile } from "./file-part";

const pdfBytes = async (text: string) => {
  const pdf = PDF.create();
  pdf.addPage({ width: 300, height: 200 }).drawText(text, {
    x: 20,
    y: 60,
    size: 14,
    font: StandardFonts.Helvetica,
  });
  return await pdf.save();
};

const RULING = await pdfBytes("Usneseni 23 C 118/2026");

const eml = (attachments: { fileName: string; bytes: Uint8Array }[]) =>
  new TextEncoder().encode(
    [
      "From: Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
      "To: Jitka Skořepová <skorepova@stavby-hradec.cz>",
      "Subject: Spis 23 C 118/2026, podklady k jednání",
      "Date: Tue, 17 Nov 2026 09:30:00 +0100",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="SPIS"',
      "",
      "--SPIS",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Dobrý den, posílám podklady k jednání dne 3. 12. 2026.",
      ...attachments.flatMap(({ fileName, bytes }) => [
        "--SPIS",
        "Content-Type: application/octet-stream",
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${fileName}"`,
        "",
        Buffer.from(bytes).toString("base64"),
      ]),
      "--SPIS--",
      "",
    ].join("\r\n"),
  );

const stored = (bytes: Uint8Array, fileName: string, mimeType: string) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    mimeType,
    path: fileName,
  });

const member = (index: number, within?: FilePart): FilePart =>
  within === undefined
    ? { kind: FILE_PART_KINDS.member, index }
    : { kind: FILE_PART_KINDS.member, index, within };

/** The archive a client sends over: every kind of container, one level in. */
const archive = async () =>
  makeZipArchive([
    {
      name: "korespondence/podklady.eml",
      data: eml([{ fileName: "usneseni.pdf", bytes: RULING }]),
    },
    {
      name: "starší spis.zip",
      data: makeZipArchive([
        { name: "protokol.txt", data: "Protokol o jednání ze dne 4. 6. 2026" },
      ]),
    },
    { name: "rozsudek.pdf.p7m", data: await wrapP7m(RULING) },
    { name: "DZ_5528193.zfo", data: await zfoFile() },
    { name: "poznámka.txt", data: "Bez dalších příloh" },
  ]);

const listOf = async (fileBytes: Uint8Array, part: FilePart) =>
  (
    await listEmbeddedParts({
      fileBytes,
      containerMimeType: ZIP_FILE_FORMAT.mimeType,
      containerName: "podklady-ke-sporu.zip",
      zipNameCodePage: "ibm437",
      part,
    })
  ).unwrap();

describe("a part that is itself a container", () => {
  test("lists its own parts, and each opens through the part link as listed", async () => {
    const bytes = await archive();
    const source = stored(bytes, "podklady-ke-sporu.zip", "application/zip");
    const expected = [
      { within: member(0), names: ["usneseni.pdf"] },
      { within: member(1), names: ["protokol.txt"] },
      { within: member(2), names: ["rozsudek.pdf"] },
      { within: member(3), names: expect.any(Array) },
    ];
    for (const { within, names } of expected) {
      const files = await listOf(bytes, within);
      expect(files?.map(({ fileName }) => fileName)).toEqual(names);
      for (const file of files ?? []) {
        const descriptor = file.part;
        expect(descriptor).not.toBeNull();
        if (descriptor === null) {
          continue;
        }
        const part = parseFilePartId(descriptor.part);
        expect(part?.within).toEqual(within);
        if (part === null) {
          continue;
        }
        const read = (await readPartOfFile(source, part, "ibm437")).unwrap();
        expect(descriptor).toEqual({
          part: descriptor.part,
          fileName: read.fileName,
          mediaType: read.mimeType,
          sizeBytes: read.bytes.byteLength,
        });
      }
    }
  });

  test("a file that is not a container lists nothing, and a part past its list opens nothing", async () => {
    const bytes = await archive();
    expect(await listOf(bytes, member(4))).toBeNull();
    expect(await listOf(bytes, member(9))).toBeNull();
    const source = stored(bytes, "podklady-ke-sporu.zip", "application/zip");
    const past = await readPartOfFile(
      source,
      {
        kind: FILE_PART_KINDS.attachment,
        index: 1,
        within: member(0),
      },
      "ibm437",
    );
    expect(past.isErr() && past.error.status).toBe(404);
    const wrongKind = await readPartOfFile(
      source,
      {
        kind: FILE_PART_KINDS.attachment,
        index: 0,
        within: member(1),
      },
      "ibm437",
    );
    expect(wrongKind.isErr() && wrongKind.error.status).toBe(404);
  });

  test("an archive attached to an email opens its files through the email", async () => {
    const zip = makeZipArchive([
      { name: "plna-moc.txt", data: "Plná moc ze dne 2. 11. 2026" },
    ]);
    const bytes = eml([
      { fileName: "usneseni.pdf", bytes: RULING },
      { fileName: "plne-moci.zip", bytes: zip },
    ]);
    const source = stored(bytes, "podklady.eml", "message/rfc822");
    const inner = {
      kind: FILE_PART_KINDS.member,
      index: 0,
      within: { kind: FILE_PART_KINDS.attachment, index: 1 },
    } satisfies FilePart;
    const read = (await readPartOfFile(source, inner, "ibm437")).unwrap();
    expect(read.fileName).toBe("plna-moc.txt");
    expect(new TextDecoder().decode(read.bytes)).toBe(
      "Plná moc ze dne 2. 11. 2026",
    );
  });

  test("a text file of an email inside keeps the charset its email declares", async () => {
    // "Lhůta k vyjádření" in Windows-1250: not UTF-8, so the charset decides.
    const cp1250 = Uint8Array.from([
      0x4c, 0x68, 0xf9, 0x74, 0x61, 0x20, 0x6b, 0x20, 0x76, 0x79, 0x6a, 0xe1,
      0x64, 0xf8, 0x65, 0x6e, 0xed,
    ]);
    expect(new TextDecoder("utf-8", { fatal: false }).decode(cp1250)).toContain(
      "�",
    );
    const email = new TextEncoder().encode(
      [
        "From: Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
        "To: Jitka Skořepová <skorepova@stavby-hradec.cz>",
        "Subject: Lhuta",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="SPIS"',
        "",
        "--SPIS",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Dobrý den.",
        "--SPIS",
        'Content-Type: text/plain; charset="windows-1250"',
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="lhuta.txt"',
        "",
        Buffer.from(cp1250).toString("base64"),
        "--SPIS--",
        "",
      ].join("\r\n"),
    );
    const files = await listOf(
      makeZipArchive([{ name: "lhuta.eml", data: email }]),
      member(0),
    );
    expect(files?.map(({ fileName, charset }) => [fileName, charset])).toEqual([
      ["lhuta.txt", "windows-1250"],
    ]);
  });

  test("a mailbox in an archive opens each message as an email, and its attachments", async () => {
    const mailbox = writeMbox(
      [
        ...MATTER_CORRESPONDENCE.map((message) => mailMessage(message)),
        eml([{ fileName: "usneseni.pdf", bytes: RULING }]),
      ],
      "mboxrd",
    );
    const bytes = makeZipArchive([
      { name: "korespondence/spis.mbox", data: mailbox.bytes },
    ]);
    const source = stored(bytes, "podklady-ke-sporu.zip", "application/zip");
    const messages = await listOf(bytes, member(0));
    expect(
      messages?.map(({ fileName, folder, part }) => [
        fileName,
        folder,
        part?.mediaType,
      ]),
    ).toEqual([
      ["Spis 23 C 118_2026, podklady k jednání.eml", "spis", "message/rfc822"],
      [
        "Re_ Spis 23 C 118_2026, podklady k jednání.eml",
        "Spisy/23 C 118-2026,Důležité",
        "message/rfc822",
      ],
      ["Vyjádření k žalobě.eml", "Spisy/Stavby Hradec", "message/rfc822"],
      ["Spis 23 C 118_2026, podklady k jednání.eml", "spis", "message/rfc822"],
    ]);
    const third = (
      await readPartOfFile(
        source,
        {
          kind: FILE_PART_KINDS.message,
          index: 1,
          within: member(0),
        },
        "ibm437",
      )
    ).unwrap();
    expect(new TextDecoder().decode(third.bytes)).toBe(
      new TextDecoder().decode(mailbox.expected[1]),
    );
    const ruling = (
      await readPartOfFile(
        source,
        {
          kind: FILE_PART_KINDS.attachment,
          index: 0,
          within: {
            kind: FILE_PART_KINDS.message,
            index: 3,
            within: member(0),
          },
        },
        "ibm437",
      )
    ).unwrap();
    expect(ruling).toMatchObject({
      fileName: "usneseni.pdf",
      mimeType: "application/pdf",
    });
    expect(ruling.bytes).toEqual(RULING);
  });

  test("an Outlook mailbox in an archive opens each message as an email, and its attachments", async () => {
    const bytes = makeZipArchive([
      { name: "export/korespondence.pst", data: pstFixture("law-firm.pst") },
    ]);
    const source = stored(bytes, "podklady-ke-sporu.zip", "application/zip");
    const messages = await listOf(bytes, member(0));
    expect(
      messages?.map(({ fileName, folder, part, unavailable }) => [
        fileName,
        folder,
        part?.mediaType ?? unavailable,
      ]),
    ).toEqual(
      LAW_FIRM_MESSAGES.map(({ fileName, folder }, index) => [
        fileName,
        folder,
        // Its list row claims more than a message may be.
        index === 6 ? "tooLarge" : "message/rfc822",
      ]),
    );
    const message = (
      await readPartOfFile(
        source,
        {
          kind: FILE_PART_KINDS.message,
          index: 1,
          within: member(0),
        },
        "ibm437",
      )
    ).unwrap();
    expect(message).toMatchObject({
      fileName: LAW_FIRM_MESSAGES[1].fileName,
      mimeType: "message/rfc822",
    });
    expect(new TextDecoder().decode(message.bytes)).toContain(
      "Subject: =?UTF-8?B?",
    );
    // A later message opens on its own, past one whose row is over the bound.
    const last = 8;
    const closing = (
      await readPartOfFile(
        source,
        { kind: FILE_PART_KINDS.message, index: last, within: member(0) },
        "ibm437",
      )
    ).unwrap();
    expect(closing.fileName).toBe(LAW_FIRM_MESSAGES[last].fileName);
    expect(LAW_FIRM_MESSAGES).toHaveLength(last + 1);
    // The message over the bound and one past the end have no part to open.
    for (const index of [6, LAW_FIRM_MESSAGES.length]) {
      expect(
        (
          await readPartOfFile(
            source,
            { kind: FILE_PART_KINDS.message, index, within: member(0) },
            "ibm437",
          )
        ).isErr(),
      ).toBe(true);
    }
    const notes = (
      await readPartOfFile(
        source,
        {
          kind: FILE_PART_KINDS.attachment,
          index: 1,
          within: {
            kind: FILE_PART_KINDS.message,
            index: 0,
            within: member(0),
          },
        },
        "ibm437",
      )
    ).unwrap();
    expect(notes.fileName).toBe("poznámky k návrhu.txt");
    expect(new TextDecoder().decode(notes.bytes)).toContain(
      "Konkurenční doložka",
    );
  });

  test("a path runs at most the deepest a part may sit", () => {
    let deepest: FilePart = member(0);
    for (let depth = 1; depth < FILE_PART_MAX_DEPTH; depth += 1) {
      deepest = member(depth, deepest);
    }
    const id = filePartId(deepest);
    expect(parseFilePartId(id)).toEqual(deepest);
    expect(parseFilePartId(`${id}/member:0`)).toBeNull();
    expect(parseFilePartId("member:0//member:1")).toBeNull();
    expect(parseFilePartId("member:0/")).toBeNull();
  });
});
