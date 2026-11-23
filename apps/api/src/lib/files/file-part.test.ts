import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { legalFileFormat } from "@stll/api-contract/document-format";
import {
  FILE_PART_KINDS,
  type FilePartDescriptor,
  type FilePartKind,
  parseFilePartId,
} from "@stll/api-contract/file-parts";
import {
  ASIC_E_FILE_FORMAT,
  ASIC_S_FILE_FORMAT,
  CADES_FILE_FORMAT,
  DATA_BOX_FILE_FORMAT,
  ISDOC_FILE_FORMAT,
  ISDOCX_FILE_FORMAT,
  type LegalFileFormatKind,
  XML_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";

import { readDataBoxPreview } from "@/api/lib/email/correspondence/data-box/read-preview";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  readAsicPreview,
  readSignedDossierPreview,
  readZipArchivePreview,
} from "@/api/lib/files/archive-preview";
import { readCadesPreview } from "@/api/lib/files/cades-preview";
import { readEInvoicePreview } from "@/api/lib/files/e-invoice-preview";
import {
  buildEmailPreview,
  describeEmailAttachments,
  parseEmail,
} from "@/api/lib/files/email-to-html";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { makeAsicFixture } from "@/api/tests/fixtures/asic";
import {
  ciiXml,
  fatturaPaXml,
  isdocXml,
  isdocxPackage,
  ublXml,
  xmlBytes,
} from "@/api/tests/fixtures/e-invoice";
import { wrapP7m } from "@/api/tests/fixtures/p7m";
import {
  makeEAktaFixture,
  makeXadesZepFixture,
  makeZepEnvelope,
  makeZepFixture,
} from "@/api/tests/fixtures/signed-dossier";
import { FIXTURE_MESSAGE, zfoFile } from "@/api/tests/fixtures/zfo";
import { makeZipArchive } from "@/api/tests/fixtures/zip-archive";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

import { LEGAL_FILE_PARTS, readPartOfFile } from "./file-part";

const encode = (text: string) => new TextEncoder().encode(text);

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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
const DOCX = new Uint8Array(
  await Bun.file(
    new URL("fixtures/folio-core-0.58.5/saved.docx", import.meta.url),
  ).arrayBuffer(),
);
const DECISION = await pdfBytes("Rozsudek ve veci 23 C 118/2026");

/** A part as a preview lists it: the fields the part link must honour. */
type Listed = Pick<
  FilePartDescriptor,
  "part" | "fileName" | "mediaType" | "sizeBytes"
>;

const listedOf = ({
  part,
  fileName,
  mediaType,
  sizeBytes,
}: Listed): Listed => ({ part, fileName, mediaType, sizeBytes });

type PartCase = {
  name: string;
  format: LegalFileFormatKind;
  kind: FilePartKind;
  fileName: string;
  /** The type the file was uploaded as; the stored file's format decides. */
  storedMimeType: string;
  bytes: () => Promise<Uint8Array>;
  /** The parts the file's own preview lists, as its handler serves them. */
  list: (source: ScannedFile) => Promise<readonly Listed[]>;
  /** How many parts the preview lists. */
  parts: number;
};

const asicMembers = async (source: ScannedFile) =>
  (await readAsicPreview(source)).unwrap().members.map(listedOf);

const dossierDocuments = async (source: ScannedFile) =>
  (await readSignedDossierPreview(source))
    .unwrap()
    .documents.flatMap(({ part }) => (part === null ? [] : [listedOf(part)]));

// A file that does not open (encrypted, a link) is listed without a part.
const zipFiles = async (source: ScannedFile) =>
  (await readZipArchivePreview(source))
    .unwrap()
    .files.flatMap(({ part }) => (part === null ? [] : [listedOf(part)]));

const invoiceAttachments = async (source: ScannedFile) => {
  const preview = (await readEInvoicePreview(source)).unwrap();
  return preview.type === "invoice"
    ? preview.invoice.attachments.map(listedOf)
    : [];
};

// `readDataBoxFile` lists a message's files at their positions.
const dataBoxFiles = async (source: ScannedFile) => {
  const preview = (await readDataBoxPreview(source)).unwrap();
  return preview.kind === "message"
    ? preview.files.map(({ fileName, mediaType, sizeBytes }, index) => ({
        part: `attachment:${String(index)}`,
        fileName,
        mediaType,
        sizeBytes,
      }))
    : [];
};

const CASES: PartCase[] = [
  {
    name: "an ASiC-E container's members, in folders and of every type",
    format: "asicE",
    kind: FILE_PART_KINDS.member,
    fileName: "smlouva-o-dilo.asice",
    storedMimeType: "application/octet-stream",
    bytes: async () =>
      await makeAsicFixture({
        members: [
          { fileName: "lepingu-lisa.txt", bytes: "Töövõtulepingu lisa nr 2" },
          { fileName: "dokumendid/otsus.pdf", bytes: DECISION },
          { fileName: "plaan.png", bytes: PNG },
          { fileName: "leping.bin", bytes: DOCX },
        ],
      }),
    list: asicMembers,
    parts: 4,
  },
  {
    name: "an ASiC-S container's one member",
    format: "asicS",
    kind: FILE_PART_KINDS.member,
    fileName: "otsus.asics",
    storedMimeType: ASIC_S_FILE_FORMAT.mimeType,
    bytes: async () =>
      await makeAsicFixture({
        mimeType: ASIC_S_FILE_FORMAT.mimeType,
        signature: "cades",
        members: [{ fileName: "otsus.pdf", bytes: DECISION }],
      }),
    list: asicMembers,
    parts: 1,
  },
  {
    name: "a ZIP archive's files in folders, a locked one without a part",
    format: "zip",
    kind: FILE_PART_KINDS.member,
    fileName: "spis-23-C-118-2026.zip",
    storedMimeType: "application/x-zip-compressed",
    bytes: async () =>
      await Promise.resolve(
        makeZipArchive([
          { name: "podání/žaloba.pdf", data: DECISION },
          { name: "zaheslovaný posudek.pdf", data: DECISION, flags: 0x00_01 },
          { name: "podání/přílohy/plánek.png", data: PNG, method: 0 },
          { name: "smlouva.bin", data: DOCX },
          { name: "poznámka.txt", data: "Lhůta k vyjádření: 15 dnů" },
        ]),
      ),
    list: zipFiles,
    parts: 4,
  },
  {
    name: "a data-box message's files, whatever their stated names",
    format: "dataBox",
    kind: FILE_PART_KINDS.attachment,
    fileName: "DZ_1284517.zfo",
    storedMimeType: DATA_BOX_FILE_FORMAT.mimeType,
    bytes: async () =>
      await zfoFile({
        files: [
          ...FIXTURE_MESSAGE.files,
          {
            name: "Výzva k doplnění/oprava podání.pdf",
            mimeType: "application/octet-stream",
            content: DECISION,
          },
          // Only the stated type says what this one is.
          { name: "snimek mapy", mimeType: "image/png", content: PNG },
        ],
      }),
    list: dataBoxFiles,
    parts: 4,
  },
  {
    name: "an e-akta dossier's documents, a nested dossier left unlisted",
    format: "eAkta",
    kind: FILE_PART_KINDS.document,
    fileName: "kérelem.es3",
    storedMimeType: "application/octet-stream",
    bytes: async () =>
      await makeEAktaFixture({
        documents: [
          {
            title: "kérelem.txt",
            extension: "txt",
            bytes: "Kérelem száma 47",
            transforms: ["zip", "base64"],
          },
          { title: "korábbi.es3", extension: "es3", bytes: "<Dossier/>" },
          { title: "végzés.pdf", extension: "pdf", bytes: DECISION },
          { title: "szerződés.docx", extension: "docx", bytes: DOCX },
        ],
        frameSigners: ["Kovács Eszter"],
      }),
    list: dossierDocuments,
    parts: 3,
  },
  {
    name: "a ZEPf container's documents",
    format: "zep",
    kind: FILE_PART_KINDS.document,
    fileName: "podanie.zep",
    storedMimeType: "application/zip",
    bytes: async () =>
      await makeZepFixture({
        envelope: makeZepEnvelope({
          body: "Žiadosť o vydanie rozhodnutia",
          attachments: [
            {
              fileName: "rozhodnutie.pdf",
              mimeType: "application/pdf",
              bytes: DECISION,
            },
          ],
        }),
      }),
    list: dossierDocuments,
    parts: 2,
  },
  {
    name: "a XAdES_ZEP envelope's documents",
    format: "xadesZep",
    kind: FILE_PART_KINDS.document,
    fileName: "podanie.xzep",
    storedMimeType: "application/xml",
    bytes: async () =>
      await makeXadesZepFixture({
        form: "enveloping",
        objects: [
          {
            id: "Data1",
            description: "Rozhodnutie",
            mimeType: "application/pdf",
            content: DECISION,
          },
          {
            id: "Data2",
            description: "Podanie",
            mimeType: "application/xml",
            content: {
              xml: "<podanie><vec>Návrh na začatie konania</vec></podanie>",
            },
          },
        ],
      }),
    list: dossierDocuments,
    parts: 2,
  },
  {
    name: "a signed envelope's document",
    format: "cades",
    kind: FILE_PART_KINDS.content,
    fileName: "rozsudek.pdf.p7m",
    storedMimeType: CADES_FILE_FORMAT.mimeType,
    bytes: async () => await wrapP7m(DECISION),
    list: async (source) => {
      const { content } = (await readCadesPreview(source)).unwrap();
      return content === null ? [] : [listedOf(content)];
    },
    parts: 1,
  },
  {
    name: "a signed FatturaPA invoice's attachments",
    format: "cades",
    kind: FILE_PART_KINDS.attachment,
    fileName: "IT01234567890_00042.xml.p7m",
    storedMimeType: CADES_FILE_FORMAT.mimeType,
    bytes: async () => await wrapP7m(xmlBytes(fatturaPaXml())),
    list: async (source) =>
      (await readCadesPreview(source))
        .unwrap()
        .invoice?.attachments.map(listedOf) ?? [],
    parts: 1,
  },
  {
    name: "an ISDOC invoice, which has no attachments",
    format: "isdoc",
    kind: FILE_PART_KINDS.attachment,
    fileName: "FV-2026-0042.isdoc",
    storedMimeType: ISDOC_FILE_FORMAT.mimeType,
    bytes: async () => xmlBytes(isdocXml()),
    list: invoiceAttachments,
    parts: 0,
  },
  {
    name: "an ISDOCX package's supplements",
    format: "isdocx",
    kind: FILE_PART_KINDS.attachment,
    fileName: "FV-2026-0042.isdocx",
    storedMimeType: ISDOCX_FILE_FORMAT.mimeType,
    bytes: async () => await isdocxPackage(),
    list: invoiceAttachments,
    parts: 1,
  },
  {
    name: "a FatturaPA invoice's attachments",
    format: "xml",
    kind: FILE_PART_KINDS.attachment,
    fileName: "IT01234567890_00042.xml",
    storedMimeType: XML_FILE_FORMAT.mimeType,
    bytes: async () => xmlBytes(fatturaPaXml()),
    list: invoiceAttachments,
    parts: 1,
  },
  {
    name: "a UBL invoice's attachments",
    format: "xml",
    kind: FILE_PART_KINDS.attachment,
    fileName: "UBL-0007.xml",
    storedMimeType: XML_FILE_FORMAT.mimeType,
    bytes: async () => xmlBytes(ublXml()),
    list: invoiceAttachments,
    parts: 1,
  },
  {
    name: "a CII invoice's attachments, named by path or by type",
    format: "xml",
    kind: FILE_PART_KINDS.attachment,
    fileName: "CII-0099.xml",
    storedMimeType: XML_FILE_FORMAT.mimeType,
    bytes: async () =>
      xmlBytes(
        ciiXml().replace("</ram:ApplicableHeaderTradeAgreement>", () =>
          [
            "<ram:AdditionalReferencedDocument>",
            "<ram:IssuerAssignedID>DL-2026-118</ram:IssuerAssignedID>",
            "<ram:TypeCode>916</ram:TypeCode>",
            "<ram:Name>Bon de livraison</ram:Name>",
            `<ram:AttachmentBinaryObject mimeCode="application/pdf" filename="livraisons/bon-118.pdf">${Buffer.from(DECISION).toString("base64")}</ram:AttachmentBinaryObject>`,
            "</ram:AdditionalReferencedDocument>",
            "<ram:AdditionalReferencedDocument>",
            "<ram:IssuerAssignedID>   </ram:IssuerAssignedID>",
            "<ram:TypeCode>916</ram:TypeCode>",
            `<ram:AttachmentBinaryObject mimeCode="image/png" filename=" ">${PNG.toString("base64")}</ram:AttachmentBinaryObject>`,
            "</ram:AdditionalReferencedDocument>",
            "</ram:ApplicableHeaderTradeAgreement>",
          ].join(""),
        ),
      ),
    list: invoiceAttachments,
    parts: 2,
  },
];

const stored = (bytes: Uint8Array, fileName: string, mimeType: string) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    mimeType,
    path: fileName,
  });

describe("a part opens as its file's preview lists it", () => {
  test("every format with parts, and every kind of part it has, is exercised", () => {
    // A part read from the stored object, never from the file's bytes (a
    // mailbox's message), is exercised against an object store in
    // `mailbox-file.test.ts` and the content delivery integration test.
    const declared = Object.entries(LEGAL_FILE_PARTS)
      .flatMap(([format, readers]) =>
        Object.entries(readers).flatMap(([kind, reading]) =>
          reading.from === "bytes" ? [`${format}/${kind}`] : [],
        ),
      )
      .toSorted();
    const fromObject = Object.entries(LEGAL_FILE_PARTS).flatMap(
      ([format, readers]) =>
        Object.entries(readers).flatMap(([kind, reading]) =>
          reading.from === "object" ? [`${format}/${kind}`] : [],
        ),
    );
    expect(fromObject).toEqual(["mbox/message"]);
    const exercised = [
      ...new Set(CASES.map(({ format, kind }) => `${format}/${kind}`)),
    ].toSorted();
    expect(exercised).toEqual(declared);
  });

  test.each(CASES)("$name", async (fixture) => {
    const source = stored(
      await fixture.bytes(),
      fixture.fileName,
      fixture.storedMimeType,
    );
    const format = legalFileFormat(source.mimeType, source.fileName);
    expect(format?.kind).toBe(fixture.format);
    const listed = await fixture.list(
      source.withMimeType(format?.mimeType ?? source.mimeType),
    );
    expect(listed).toHaveLength(fixture.parts);

    const positions = new Set<number>();
    for (const descriptor of listed) {
      const part = parseFilePartId(descriptor.part);
      expect(part?.kind).toBe(fixture.kind);
      if (part === null) {
        continue;
      }
      positions.add(part.index);
      const read = (await readPartOfFile(source, part)).unwrap();
      expect(descriptor).toEqual({
        part: descriptor.part,
        fileName: read.fileName,
        mediaType: read.mimeType,
        sizeBytes: read.bytes.byteLength,
      });
    }

    // Nothing the preview does not list opens, up to one past its last part.
    const end = Math.max(-1, ...positions) + 2;
    for (let index = 0; index < end; index += 1) {
      if (positions.has(index)) {
        continue;
      }
      const refused = await readPartOfFile(source, {
        kind: fixture.kind,
        index,
      });
      expect({
        index,
        status: refused.isErr() && refused.error.status,
      }).toEqual({ index, status: 404 });
    }
  });

  test("the fixtures reach the cases the rule exists for", async () => {
    // A part listed by its bytes, against its name or its stated type.
    const asic = await asicMembers(
      stored(
        await makeAsicFixture({
          members: [{ fileName: "leping.bin", bytes: DOCX }],
        }),
        "leping.asice",
        ASIC_E_FILE_FORMAT.mimeType,
      ),
    );
    expect(asic.map(({ mediaType }) => mediaType)).toEqual([DOCX_MIME_TYPE]);
    // A stated name that is not a safe file name.
    const message = await dataBoxFiles(
      stored(
        await zfoFile({
          files: [
            {
              name: "Výzva k doplnění/oprava podání.pdf",
              mimeType: "application/octet-stream",
              content: DECISION,
            },
          ],
        }),
        "DZ_1284517.zfo",
        DATA_BOX_FILE_FORMAT.mimeType,
      ),
    );
    expect(message).toEqual([
      expect.objectContaining({
        fileName: expect.not.stringContaining("/"),
        mediaType: PDF_MIME_TYPE,
      }),
    ]);
  });
});

describe("an email's parts are the attachments its preview lists", () => {
  const PNG_BASE64 = PNG.toString("base64");
  const eml = [
    "From: Tereza Malá <tereza.mala@advokatni-mala.cz>",
    "To: podatelna@ksoud.brn.justice.cz",
    "Subject: Doplnění žaloby, sp. zn. 23 C 118/2026",
    "Date: Mon, 16 Nov 2026 10:00:00 +0100",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="BND"',
    "",
    "--BND",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<html><body><p>Dobrý den, v příloze zasílám doplnění.</p><img src="cid:podpis"></body></html>',
    "--BND",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <podpis>",
    'Content-Disposition: inline; filename="podpis.png"',
    "",
    PNG_BASE64,
    "--BND",
    "Content-Type: application/octet-stream",
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="doplneni.pdf"',
    "",
    Buffer.from(DECISION).toString("base64"),
    "--BND",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <plan>",
    'Content-Disposition: attachment; filename="plan.png"',
    "",
    PNG_BASE64,
    "--BND--",
    "",
  ].join("\r\n");

  test("each listed position opens as listed, an inline image of the body never does", async () => {
    const bytes = encode(eml);
    const parsed = (
      await parseEmail(new Uint8Array(bytes).buffer, "message/rfc822")
    ).unwrap();
    const positions = buildEmailPreview(parsed).attachments;
    const inline = parsed.attachments.findIndex(
      ({ contentId }) => contentId === "podpis",
    );
    // The fixture holds a body image as an attachment of the message.
    expect(inline).toBeGreaterThanOrEqual(0);
    expect(positions).not.toContain(inline);
    expect(positions.length).toBe(parsed.attachments.length - 1);

    const listed = await describeEmailAttachments(parsed, positions);
    const source = stored(bytes, "doplneni-zaloby.eml", "message/rfc822");
    for (const descriptor of listed) {
      const part = parseFilePartId(descriptor.part);
      if (part === null) {
        throw new Error(`Unaddressable part ${descriptor.part}`);
      }
      const read = (await readPartOfFile(source, part)).unwrap();
      expect(listedOf(descriptor)).toEqual({
        part: descriptor.part,
        fileName: read.fileName,
        mediaType: read.mimeType,
        sizeBytes: read.bytes.byteLength,
      });
    }
    expect(listed.map(({ mediaType }) => mediaType)).toEqual([
      PDF_MIME_TYPE,
      "image/png",
    ]);

    for (let index = 0; index <= parsed.attachments.length; index += 1) {
      const read = await readPartOfFile(source, {
        kind: FILE_PART_KINDS.attachment,
        index,
      });
      expect({ index, opens: read.isOk() }).toEqual({
        index,
        opens: positions.includes(index),
      });
    }
  });
});
