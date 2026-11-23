import { describe, expect, test } from "bun:test";
import type { InferOutput } from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import type { asicPreviewSchema } from "@stll/api-contract/asic";
import {
  DATA_BOX_DOCUMENT_KIND,
  DATA_BOX_MESSAGE_MIME_TYPE,
} from "@stll/api-contract/data-box";
import type { EInvoicePreview } from "@stll/api-contract/e-invoice";
import type { EmailReading } from "@stll/api-contract/email-reading";
import type { UnscannedContentReason } from "@stll/api-contract/file-scan-warnings";
import type { MailboxPreview } from "@stll/api-contract/mailbox";
import type { signedDossierPreviewSchema } from "@stll/api-contract/signed-dossier";
import type { ZipArchivePreview } from "@stll/api-contract/zip-archive";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import {
  currentVersionFile,
  fileUrlPath,
  isOffline,
  readDocumentEmailPart,
  readDocumentFile,
  readDocumentPart,
  readDocumentPartList,
  readOriginalDocumentFile,
  saveDocumentPart,
  versionsPath,
  viewerFor,
} from "./document-file";

const SESSION: StoredSession = {
  signInId: "sign-in-1",
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const sourceFor = (fetch: Fetch) => {
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  return createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store,
    generation: store.generation(),
  });
};

/** A server answering each path with `respond`, recording what was asked. */
const server = (respond: (path: string) => Response) => {
  const calls: string[] = [];
  const fetch: Fetch = async (input) => {
    const path = input.replace(SESSION.serverUrl, "");
    calls.push(path);
    return respond(path);
  };
  return { fetch, calls };
};

const history = (
  currentVersionId: string | null,
  versions: {
    id: string;
    versionNumber?: number;
    file: {
      fieldId: string;
      fileName?: string;
      mimeType?: string;
      unscannedContent?: UnscannedContentReason[];
    } | null;
  }[],
) => ({
  entityId: "entity-1",
  currentVersionId,
  versions: versions.map((version) => ({
    versionNumber: 1,
    ...version,
    file:
      version.file === null
        ? null
        : {
            propertyId: "property-1",
            fileName: "Smlouva.docx",
            mimeType: DOCX,
            unscannedContent: [],
            ...version.file,
            sizeBytes: 1200,
          },
  })),
});

const invoicePreview = {
  syntax: "ubl",
  version: "2.1",
  invoices: [
    {
      documentType: "invoice",
      typeCode: "380",
      number: "FV-2026-0117",
      issueDate: "2026-01-15",
      taxPointDate: null,
      dueDate: "2026-01-29",
      currency: "EUR",
      seller: {
        name: "Tiskárna Vltava s.r.o.",
        identifiers: [{ kind: "vat", scheme: null, value: "XX0000000001" }],
        address: ["Na Poříčí 1041/12", "110 00 Praha 1"],
      },
      buyer: {
        name: "Dvořák & Šimek, advokátní kancelář",
        identifiers: [],
        address: [],
      },
      lines: [
        {
          id: "1",
          description: "Tisk podání, leden 2026",
          quantity: "1",
          unitCode: "C62",
          unitPrice: "100.00",
          priceBasis: null,
          vatRate: "20",
          vatCategory: "S",
          netAmount: "100.00",
        },
      ],
      lineCount: 1,
      vatBreakdown: [],
      totals: {
        netAmount: "100.00",
        taxAmount: "20.00",
        grossAmount: "120.00",
        prepaidAmount: null,
        payableAmount: "120.00",
      },
      payments: [],
      notes: [],
    },
  ],
  attachments: [
    {
      part: "attachment:0",
      fileName: "dodaci-list-0117.pdf",
      mediaType: "application/pdf",
      description: "Dodací list k faktuře",
      sizeBytes: 48_213,
    },
  ],
} satisfies EInvoicePreview;

const delivered = (mimeType: string, extra: object = {}) => ({
  fileId: "file-1",
  fileName: "Smlouva.docx",
  mimeType,
  originalMimeType: mimeType,
  presignedUrl: "https://storage.example.com/file-1?signature=abc",
  stampable: false,
  ...extra,
});

describe("where a file opens", () => {
  test("a Word document in folio and a PDF in pdf.js", () => {
    expect(viewerFor(DOCX)).toBe("docx");
    expect(viewerFor("application/pdf")).toBe("pdf");
    expect(viewerFor("Application/PDF; charset=binary")).toBe("pdf");
  });

  test("anything else in Quick Look", () => {
    expect(viewerFor(XLSX)).toBe("quick-look");
    expect(viewerFor("image/jpeg")).toBe("quick-look");
    expect(viewerFor("message/rfc822")).toBe("quick-look");
    expect(viewerFor("")).toBe("quick-look");
  });
});

describe("the current version's file", () => {
  test("is the file of the version the server names current", () => {
    expect(
      currentVersionFile(
        history("version-1", [
          { id: "version-2", file: { fieldId: "field-2" } },
          { id: "version-1", file: { fieldId: "field-1" } },
        ]),
      )?.fieldId,
    ).toBe("field-1");
  });

  test("is the newest version's file when the current one has none", () => {
    expect(
      currentVersionFile(
        history("version-3", [
          { id: "version-3", file: null },
          { id: "version-2", file: { fieldId: "field-2" } },
        ]),
      )?.fieldId,
    ).toBe("field-2");
  });

  test("names the version its file is of, so an edit can start from it", () => {
    const current = (currentVersionId: string) =>
      currentVersionFile(
        history(currentVersionId, [
          { id: "version-3", versionNumber: 3, file: null },
          { id: "version-2", versionNumber: 2, file: { fieldId: "field-2" } },
          { id: "version-1", versionNumber: 1, file: { fieldId: "field-1" } },
        ]),
      );
    expect(current("version-1")).toMatchObject({
      fieldId: "field-1",
      versionNumber: 1,
    });
    expect(current("version-3")).toMatchObject({
      fieldId: "field-2",
      versionNumber: 2,
    });
  });

  test("is missing for a document without a file", () => {
    expect(
      currentVersionFile(history(null, [{ id: "version-1", file: null }])),
    ).toBeNull();
  });
});

test("paths escape what they interpolate", () => {
  expect(versionsPath("matter 1", "doc/1")).toBe(
    "/v1/entities/matter%201/entity/doc%2F1/versions",
  );
  expect(fileUrlPath("matter-1", "field?1", "display")).toBe(
    "/v1/files/matter-1/url/field%3F1?purpose=display",
  );
});

describe("reading a document's file", () => {
  const read = async (fetch: Fetch) =>
    await readDocumentFile({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "matter-1",
      entityId: "entity-1",
    });

  test("asks for what a viewer shows, and routes by the delivered type", async () => {
    const { fetch, calls } = server((path) =>
      path.endsWith("/versions")
        ? Response.json(
            history("version-1", [
              { id: "version-1", file: { fieldId: "field-1" } },
            ]),
          )
        : Response.json(delivered("application/pdf")),
    );
    const result = await read(fetch);
    expect(result.isOk() ? result.value : result.error).toEqual({
      propertyId: "property-1",
      versionNumber: 1,
      fileName: "Smlouva.docx",
      mimeType: "application/pdf",
      url: "https://storage.example.com/file-1?signature=abc",
      viewer: "pdf",
      unscannedContent: [],
    });
    expect(calls).toEqual([
      "/v1/entities/matter-1/entity/entity-1/versions",
      "/v1/files/matter-1/url/field-1?purpose=display",
    ]);
  });

  test("names the content the upload scan could not read", async () => {
    const { fetch } = server((path) =>
      path.endsWith("/versions")
        ? Response.json(
            history("version-1", [
              {
                id: "version-1",
                file: {
                  fieldId: "field-1",
                  unscannedContent: ["encrypted", "unsupportedCompression"],
                },
              },
            ]),
          )
        : Response.json(delivered("application/pdf")),
    );
    const result = await read(fetch);
    expect(result.isOk() && result.value.unscannedContent).toEqual([
      "encrypted",
      "unsupportedCompression",
    ]);
  });

  test("opens the stored file in Quick Look when there is nothing to display", async () => {
    const { fetch, calls } = server((path) => {
      if (path.endsWith("/versions")) {
        return Response.json(
          history("version-1", [
            { id: "version-1", file: { fieldId: "field-1" } },
          ]),
        );
      }
      return path.endsWith("purpose=display")
        ? Response.json({ message: "Not displayable" }, { status: 400 })
        : Response.json(delivered("image/heic"));
    });
    const result = await read(fetch);
    expect(result.isOk() && result.value.viewer).toBe("quick-look");
    expect(calls.at(-1)).toBe(
      "/v1/files/matter-1/url/field-1?purpose=download",
    );
  });

  const legalFileVersion = (fileName: string, mimeType: string) =>
    history("version-1", [
      { id: "version-1", file: { fieldId: "field?1", fileName, mimeType } },
    ]);

  test.each([
    [
      "Doručenka.ZFO",
      "application/octet-stream",
      DATA_BOX_DOCUMENT_KIND.receipt,
    ],
    [
      "Datová zpráva",
      DATA_BOX_MESSAGE_MIME_TYPE,
      DATA_BOX_DOCUMENT_KIND.message,
    ],
  ] as const)(
    "opens %s through the audited data-box preview",
    async (fileName, mimeType, kind) => {
      const text = "Datová schránka: 1234567\n\n  Přijato: 15:20";
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion(fileName, mimeType)
            : { kind, text },
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(file.viewer === "dataBox" && file.preview.unwrap()).toEqual({
        kind,
        text,
        files: [],
      });
      expect(file.fileName).toBe(fileName);
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/data-box/field%3F1",
      ]);
    },
  );

  const certifiedRead = {
    certified: {
      system: "pec",
      kind: "delivery",
      error: "none",
      errorDetail: null,
      sender: "mittente@pec.example.com",
      recipients: [
        { address: "destinatario@pec.example.com", certified: true },
      ],
      replyTo: null,
      subject: "Notifica",
      provider: "Posta Sicura Lombardia S.p.A.",
      certifiedAt: "2026-11-21T09:15:30.000Z",
      messageId: "opec-fixture@pec.example.com",
      originalMessageId: null,
      receiptType: "full",
      deliveredTo: "destinatario@pec.example.com",
      receivedFor: [],
      includesOriginal: true,
      signature: {
        status: "unverified",
        signerName: null,
        issuerName: null,
        serialNumber: null,
        signedAt: null,
      },
    },
    subject: "Notifica atto di citazione",
    from: "Studio legale Ferraro <segreteria@pec.example.com>",
    to: ["destinatario@pec.example.com"],
    cc: [],
    date: "2026-11-21T09:15:00.000Z",
    text: "Si trasmette in allegato l'atto di citazione.",
    attachments: [
      {
        part: "attachment:0",
        fileName: "atto-di-citazione.pdf",
        mediaType: "application/pdf",
        sizeBytes: 182_406,
      },
    ],
  } satisfies EmailReading;

  const plainRead = {
    certified: null,
    subject: "Návrh smlouvy o dílo",
    from: "Jana Procházková <prochazkova@example.cz>",
    to: ["kancelar@example.cz"],
    cc: ["Petr Vlček <vlcek@example.cz>"],
    date: "Thu, 01 Oct 2026 09:30:00 +0200",
    text: "Dobrý den, v příloze posílám návrh smlouvy.",
    attachments: [
      {
        part: "attachment:0",
        fileName: "smlouva-o-dilo-navrh.docx",
        mediaType: DOCX,
        sizeBytes: 38_912,
      },
      {
        part: "attachment:2",
        fileName: null,
        mediaType: "application/octet-stream",
        sizeBytes: 512,
      },
    ],
  } satisfies EmailReading;

  test.each([
    ["a certified email", "Consegna.eml", "message/rfc822", certifiedRead],
    ["a plain email", "Návrh smlouvy.eml", "message/rfc822", plainRead],
    [
      "an Outlook message",
      "Návrh smlouvy.msg",
      "application/vnd.ms-outlook",
      plainRead,
    ],
    [
      "an Outlook TNEF stream",
      "winmail.dat",
      "application/octet-stream",
      plainRead,
    ],
    ["a TNEF stream by its type", "zprava", "application/ms-tnef", plainRead],
  ] as const)(
    "opens %s through the audited email reading",
    async (_, fileName, mimeType, reading) => {
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion(fileName, mimeType)
            : reading,
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(file.viewer === "email" && file.preview.unwrap()).toEqual(reading);
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/email-reading/field%3F1",
      ]);
    },
  );

  test("opens an email the server cannot read as before", async () => {
    const { fetch, calls } = server((path) => {
      if (path.endsWith("/versions")) {
        return Response.json(legalFileVersion("Lettera.eml", "message/rfc822"));
      }
      return path.includes("/email-reading/")
        ? Response.json(
            { code: PREVIEW_UNAVAILABLE_ERROR_CODE, message: "Unreadable" },
            { status: 422 },
          )
        : Response.json(delivered("application/pdf"));
    });
    const file = (await read(fetch)).unwrap();
    expect(file.viewer).toBe("pdf");
    expect(calls).toEqual([
      "/v1/entities/matter-1/entity/entity-1/versions",
      "/v1/files/matter-1/email-reading/field%3F1",
      "/v1/files/matter-1/url/field%3F1?purpose=display",
    ]);
  });

  test("opens an .xml as before when the server cannot read it as text", async () => {
    const { fetch, calls } = server((path) => {
      if (path.endsWith("/versions")) {
        return Response.json(legalFileVersion("settings.xml", "text/xml"));
      }
      if (path.includes("/e-invoice/")) {
        return Response.json(
          { code: PREVIEW_UNAVAILABLE_ERROR_CODE, message: "Not readable" },
          { status: 422 },
        );
      }
      return path.endsWith("purpose=display")
        ? Response.json({ message: "Not displayable" }, { status: 400 })
        : Response.json(delivered("text/xml", { fileName: "settings.xml" }));
    });
    const file = (await read(fetch)).unwrap();
    expect(file.viewer).toBe("quick-look");
    expect(calls.slice(0, 3)).toEqual([
      "/v1/entities/matter-1/entity/entity-1/versions",
      "/v1/files/matter-1/e-invoice/field%3F1",
      "/v1/files/matter-1/url/field%3F1?purpose=display",
    ]);
  });

  test("keeps an email's failed reading for a retry", async () => {
    const { fetch } = server((path) =>
      path.endsWith("/versions")
        ? Response.json(legalFileVersion("Consegna.eml", "message/rfc822"))
        : Response.json({ message: "Unavailable" }, { status: 503 }),
    );
    const file = (await read(fetch)).unwrap();
    expect(file.viewer).toBe("email");
    expect(file.viewer === "email" && file.preview.isErr()).toBe(true);
  });

  test("never asks a file that is not an email for an email reading", async () => {
    const { fetch, calls } = server((path) =>
      path.endsWith("/versions")
        ? Response.json(legalFileVersion("Smlouva.pdf", "application/pdf"))
        : Response.json(delivered("application/pdf")),
    );
    await read(fetch);
    expect(calls.some((path) => path.includes("/email-reading/"))).toBe(false);
  });

  test.each([
    {
      fileName: "Verbale.pdf",
      mimeType: "application/pdf",
      text: "Il testo del verbale",
      textFormat: "markdown",
      content: {
        part: "content:0",
        fileName: "Verbale.pdf",
        mediaType: "application/pdf",
        sizeBytes: 96_310,
      },
    },
    {
      fileName: "Allegato.bin",
      mimeType: "application/octet-stream",
      text: "",
      textFormat: "plain",
      content: null,
    },
  ] as const)(
    "keeps $mimeType signed-file metadata without requesting the original",
    async (embedded) => {
      const fileName = `${embedded.fileName}.P7M`;
      const preview = {
        ...embedded,
        layers: [
          {
            id: "layer-0",
            signers: [
              { id: "layer-0.signer-0", name: "Anna Rossi" },
              { id: "layer-0.signer-1", name: null },
            ],
          },
        ],
        invoice: null,
      };
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion(fileName, "application/octet-stream")
            : preview,
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(file.viewer === "cades" && file.preview.unwrap()).toEqual(preview);
      expect(file.fileName).toBe(fileName);
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/cades/field%3F1",
      ]);
    },
  );

  test("keeps the invoice a signed file holds", async () => {
    const fileName = "IT00000000000_00A7K.xml.p7m";
    const preview = {
      fileName: "IT00000000000_00A7K.xml",
      mimeType: "application/xml",
      text: "<FatturaElettronica/>",
      textFormat: "plain" as const,
      layers: [
        {
          id: "layer-0",
          signers: [{ id: "layer-0.signer-0", name: "Marco Bellini" }],
        },
      ],
      content: {
        part: "content:0",
        fileName: "IT00000000000_00A7K.xml",
        mediaType: "application/xml",
        sizeBytes: 5812,
      },
      invoice: {
        ...invoicePreview,
        syntax: "fatturaPA" as const,
        version: "FPR12",
      },
    };
    const { fetch } = server((path) =>
      Response.json(
        path.endsWith("/versions")
          ? legalFileVersion(fileName, "application/pkcs7-mime")
          : preview,
      ),
    );
    const file = (await read(fetch)).unwrap();
    expect(file.viewer === "cades" && file.preview.unwrap().invoice).toEqual(
      preview.invoice,
    );
  });

  test.each([
    { fileName: "FV-2026-0117.isdoc", format: "isdoc" },
    { fileName: "FV-2026-0117.ISDOCX", format: "isdocx" },
    { fileName: "FV-2026-0117.xml", format: "xml" },
  ] as const)(
    "reads $fileName through the structured invoice preview",
    async ({ fileName, format }) => {
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion(fileName, "application/octet-stream")
            : { type: "invoice", invoice: invoicePreview },
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(file).toMatchObject({ viewer: "e-invoice", format, fileName });
      expect(file.viewer === "e-invoice" && file.preview.unwrap()).toEqual({
        type: "invoice",
        invoice: invoicePreview,
      });
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/e-invoice/field%3F1",
      ]);
    },
  );

  test.each(["application/xml", "text/xml"])(
    "reads an XML file typed %s as a possible invoice",
    async (mimeType) => {
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion("export", mimeType)
            : { type: "xml", text: "<export/>", truncated: false },
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(file).toMatchObject({ viewer: "e-invoice", format: "xml" });
      expect(calls.at(-1)).toBe("/v1/files/matter-1/e-invoice/field%3F1");
    },
  );

  test.each([".ASICE", ".sce", ".bdoc", ".asics", ".scs"])(
    "reads an ASiC archive with the %s extension through the preview",
    async (extension) => {
      const fileName = `appendices${extension}`;
      const preview = {
        members: [
          {
            part: "member:0",
            fileName: "hagi-avaldus.pdf",
            mediaType: "application/pdf",
            sizeBytes: 211_004,
            status: "readable",
            text: "Hagiavaldus Harju Maakohtule",
            textFormat: "markdown",
          },
          {
            part: "member:1",
            fileName: "lisa-1.bin",
            mediaType: "application/octet-stream",
            sizeBytes: 4096,
            status: "unavailable",
            text: "",
            textFormat: "plain",
          },
          {
            part: "member:2",
            fileName: "markused.txt",
            mediaType: "text/plain",
            sizeBytes: 90_112,
            status: "truncated",
            text: "Esimene lehekülg",
            textFormat: "plain",
          },
        ],
      } satisfies InferOutput<typeof asicPreviewSchema>;
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion(fileName, "application/octet-stream")
            : preview,
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(file.viewer === "asic" && file.preview.unwrap()).toEqual(preview);
      expect(file.fileName).toBe(fileName);
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/asic/field%3F1",
      ]);
    },
  );

  test.each([
    ["spis-23-C-118-2026.zip", "application/zip"],
    ["Prilohy.ZIP", "application/octet-stream"],
    ["podklady", "application/x-zip-compressed"],
  ])(
    "reads the archive %s (%s) through the archive preview",
    async (fileName, mimeType) => {
      const preview = {
        files: [
          {
            fileName: "žaloba.pdf",
            folder: "podání",
            sizeBytes: 88_310,
            part: {
              part: "member:0",
              fileName: "žaloba.pdf",
              mediaType: "application/pdf",
              sizeBytes: 88_310,
            },
            unavailable: null,
            text: "Žaloba",
            textFormat: "markdown",
            status: "readable",
          },
          {
            fileName: "posudek.pdf",
            folder: null,
            sizeBytes: 120_400,
            part: null,
            unavailable: "encrypted",
            text: "",
            textFormat: "plain",
            status: "unavailable",
          },
        ],
      } satisfies ZipArchivePreview;
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion(fileName, mimeType)
            : preview,
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(file.viewer === "zip" && file.preview.unwrap()).toEqual(preview);
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/zip/field%3F1",
      ]);
    },
  );

  test.each([
    ["spis-23-C-118-2026.mbox", "application/mbox"],
    ["Doručená pošta.mbox", "application/octet-stream"],
    ["korespondence.MBX", "application/octet-stream"],
    ["korespondence.pst", "application/octet-stream"],
    ["Archiv 2023.PST", "application/vnd.ms-outlook-pst"],
  ])(
    "reads the mailbox %s (%s) through the mailbox preview",
    async (fileName, mimeType) => {
      const preview = {
        truncated: false,
        messages: [
          {
            fileName: "Spis 23 C 118_2026.eml",
            folder: "Spisy/Stavby Hradec",
            sizeBytes: 4210,
            subject: "Spis 23 C 118/2026",
            from: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
            date: "2026-11-17T08:30:00.000Z",
            part: {
              part: "message:0",
              fileName: "Spis 23 C 118_2026.eml",
              mediaType: "message/rfc822",
              sizeBytes: 4210,
            },
            unavailable: null,
          },
          {
            fileName: "korespondence-2.eml",
            folder: null,
            sizeBytes: 40_000_000,
            subject: null,
            from: null,
            date: null,
            part: null,
            unavailable: "tooLarge",
          },
        ],
      } satisfies MailboxPreview;
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion(fileName, mimeType)
            : preview,
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(file.viewer === "mailbox" && file.preview.unwrap()).toEqual(
        preview,
      );
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/mbox/field%3F1",
      ]);
    },
  );

  test.each([".ES3", ".et3", ".dosszie", ".zep", ".xzep", ".ZEPX"])(
    "reads a signed container with the %s extension through its preview",
    async (extension) => {
      const fileName = `podanie${extension}`;
      const preview = {
        receipt: extension === ".et3",
        signers: [
          { id: "signature-0", name: "Tóth Eszter" },
          { id: "signature-1", name: null },
        ],
        documents: [
          {
            id: "document-0",
            fileName: "határozat.pdf",
            status: "readable",
            text: "Az első oldal",
            textFormat: "markdown",
            part: {
              part: "document:0",
              fileName: "határozat.pdf",
              mediaType: "application/pdf",
              sizeBytes: 154_880,
            },
          },
          {
            id: "document-1",
            fileName: "príloha.bin",
            status: "unavailable",
            text: "",
            textFormat: "plain",
            part: null,
          },
        ],
      } satisfies InferOutput<typeof signedDossierPreviewSchema>;
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion(fileName, "application/octet-stream")
            : preview,
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(file.viewer === "signed-dossier" && file.preview.unwrap()).toEqual(
        preview,
      );
      expect(file.fileName).toBe(fileName);
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/signed-dossier/field%3F1",
      ]);
    },
  );

  test.each([".UDF", ".ofd"])(
    "reads a %s file through the shared text preview",
    async (extension) => {
      const fileName = `submission${extension}`;
      const preview = { text: "İlk sayfa\n法院文件", truncated: true };
      const { fetch, calls } = server((path) =>
        Response.json(
          path.endsWith("/versions")
            ? legalFileVersion(fileName, "application/octet-stream")
            : preview,
        ),
      );
      const file = (await read(fetch)).unwrap();
      expect(
        file.viewer === "structured-document" && file.preview.unwrap(),
      ).toEqual(preview);
      expect(file.fileName).toBe(fileName);
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/structured-document/field%3F1",
      ]);
    },
  );

  test.each([
    {
      viewer: "asic",
      fileName: "Detached.asice",
      mimeType: "application/vnd.etsi.asic-e+zip",
    },
    {
      viewer: "signed-dossier",
      fileName: "Podanie.zep",
      mimeType: "application/zip",
    },
    {
      viewer: "structured-document",
      fileName: "Submission.udf",
      mimeType: "application/octet-stream",
    },
    {
      viewer: "structured-document",
      fileName: "Submission.ofd",
      mimeType: "application/octet-stream",
    },
    {
      viewer: "dataBox",
      fileName: "Doručenka.zfo",
      mimeType: DATA_BOX_MESSAGE_MIME_TYPE,
    },
    {
      viewer: "e-invoice",
      fileName: "FV-2026-0117.isdocx",
      mimeType: "application/octet-stream",
    },
    {
      viewer: "cades",
      fileName: "Detached.p7m",
      mimeType: "application/pkcs7-mime",
    },
  ])(
    "keeps the original available when a $viewer preview is refused",
    async ({ viewer, fileName, mimeType }) => {
      const { fetch, calls } = server((path) => {
        if (path.endsWith("/versions")) {
          return Response.json(legalFileVersion(fileName, mimeType));
        }
        if (path.endsWith("purpose=download")) {
          return Response.json(delivered(mimeType, { fileName }));
        }
        return Response.json(
          { message: "Unreadable", code: "preview_unavailable" },
          { status: 422 },
        );
      });
      const file = (await read(fetch)).unwrap();
      expect(
        file.viewer === viewer &&
          file.preview.status === "error" &&
          file.preview.error,
      ).toMatchObject({
        status: 422,
        code: "preview_unavailable",
      });
      expect(calls).toHaveLength(2);
      const original = await readOriginalDocumentFile({
        fetch,
        source: sourceFor(fetch),
        workspaceId: "matter-1",
        fieldId: "field?1",
      });
      expect(original.unwrap()).toMatchObject({
        fileName,
        presignedUrl: "https://storage.example.com/file-1?signature=abc",
      });
      expect(calls.at(-1)).toBe(
        "/v1/files/matter-1/url/field%3F1?purpose=download",
      );
    },
  );

  test("lists a data-box message's files, which open as its parts", async () => {
    const { fetch, calls } = server((path) => {
      if (path.endsWith("/versions")) {
        return Response.json(
          history("version-1", [
            {
              id: "version-1",
              file: {
                fieldId: "field-1",
                fileName: "zprava.zfo",
                mimeType: "application/octet-stream",
              },
            },
          ]),
        );
      }
      if (path.includes("/data-box/")) {
        return Response.json({
          kind: "message",
          text: "Datová zpráva",
          files: [
            {
              part: "attachment:0",
              fileName: "usneseni.pdf",
              mediaType: "application/pdf",
              sizeBytes: 73_216,
              entityId: null,
            },
          ],
        });
      }
      return Response.json(
        delivered("application/pdf", { fileName: "usneseni.pdf" }),
      );
    });
    const file = (await read(fetch)).unwrap();
    // Listed as parts; which document a file was filed as is not shown here.
    expect(file.viewer === "dataBox" && file.preview.unwrap().files).toEqual([
      {
        part: "attachment:0",
        fileName: "usneseni.pdf",
        mediaType: "application/pdf",
        sizeBytes: 73_216,
      },
    ]);
    const part = await readDocumentPart({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "matter-1",
      fieldId: "field-1",
      part: "attachment:0",
      mediaType: "application/pdf",
    });
    expect(part.unwrap()).toMatchObject({
      fileName: "usneseni.pdf",
      presignedUrl: "https://storage.example.com/file-1?signature=abc",
    });
    // A part opens through the file's own audited link, for download.
    expect(calls.at(-1)).toBe(
      "/v1/files/matter-1/url/field-1?purpose=download&part=attachment%3A0",
    );
  });

  test("the files inside a part are listed by its path, each with its own", async () => {
    const files = [
      {
        fileName: "usneseni.pdf",
        folder: null,
        sizeBytes: 4210,
        part: {
          part: "member:2/attachment:0",
          fileName: "usneseni.pdf",
          mediaType: "application/pdf",
          sizeBytes: 4210,
        },
        unavailable: null,
      },
    ];
    const { fetch, calls } = server(() => Response.json({ files }));
    const listed = await readDocumentPartList({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "matter-1",
      fieldId: "field-1",
      part: "member:2",
    });
    expect(listed.unwrap().files).toEqual(files);
    expect(calls.at(-1)).toBe(
      "/v1/files/matter-1/parts/field-1?part=member%3A2",
    );
  });

  test("a part is saved into the chosen matter at its top", async () => {
    const sent: { path: string; method: string | undefined; body: unknown }[] =
      [];
    const fetch: Fetch = async (input, init) => {
      sent.push({
        path: input.replace(SESSION.serverUrl, ""),
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({
        entityId: "entity-9",
        fieldId: "field-9",
        fileName: "plna-moc.pdf",
        workspaceId: "matter-2",
      });
    };
    const saved = await saveDocumentPart({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "matter-1",
      fieldId: "field-1",
      part: "message:3/attachment:0",
      destinationWorkspaceId: "matter-2",
    });
    expect(saved.unwrap()).toMatchObject({ workspaceId: "matter-2" });
    expect(sent).toEqual([
      {
        path: "/v1/files/matter-1/part/field-1/save",
        method: "POST",
        body: {
          part: "message:3/attachment:0",
          destinationWorkspaceId: "matter-2",
          parentId: null,
        },
      },
    ]);
  });

  test("a mailbox's message is read as an email by its path", async () => {
    const reading = {
      certified: null,
      subject: "Plná moc a výzva",
      from: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
      to: ["Jitka Skořepová <skorepova@stavby-hradec.cz>"],
      cc: [],
      date: "2026-11-19T09:15:00.000Z",
      text: "Dobrý den, v příloze posílám plnou moc.",
      attachments: [
        {
          part: "message:3/attachment:0",
          fileName: "plna-moc.pdf",
          mediaType: "application/pdf",
          sizeBytes: 5120,
        },
      ],
    } satisfies EmailReading;
    const { fetch, calls } = server(() => Response.json(reading));
    const message = await readDocumentEmailPart({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "matter-1",
      fieldId: "field-1",
      part: "message:3",
    });
    expect(message.unwrap()).toEqual(reading);
    expect(calls.at(-1)).toBe(
      "/v1/files/matter-1/email-reading/field-1?part=message%3A3",
    );
  });

  test("a refused part is the server's refusal, not an empty file", async () => {
    const { fetch } = server(() =>
      Response.json(
        { message: "The file has no such part", code: "not_found" },
        { status: 404 },
      ),
    );
    const part = await readDocumentPart({
      fetch,
      source: sourceFor(fetch),
      workspaceId: "matter-1",
      fieldId: "field-1",
      part: "member:9",
      mediaType: "text/plain",
    });
    expect(part.isErr() && part.error).toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  test("opens a document part no viewer draws as the PDF the server converts it to", async () => {
    const { fetch, calls } = server(() =>
      Response.json(delivered("application/pdf", { fileName: "zaloba.pdf" })),
    );
    const open = async (part: string, mediaType: string) =>
      await readDocumentPart({
        fetch,
        source: sourceFor(fetch),
        workspaceId: "matter-1",
        fieldId: "field-1",
        part,
        mediaType,
      });

    // A Word 97 and a WordPerfect attachment open as their PDF renditions,
    expect(
      (await open("attachment:3", "application/msword")).isOk(),
    ).toBeTrue();
    expect(calls.at(-1)).toBe(
      "/v1/files/matter-1/url/field-1?purpose=display&part=attachment%3A3",
    );
    await open("attachment:4", "application/vnd.wordperfect");
    expect(calls.at(-1)).toContain("purpose=display");
    // while a Word document, a PDF and text open whole, as themselves.
    for (const mediaType of [DOCX, "application/pdf", "text/plain"]) {
      await open("attachment:0", mediaType);
      expect(calls.at(-1)).toContain("purpose=download");
    }
  });

  test("sends a password-protected file to Quick Look", async () => {
    const { fetch } = server((path) =>
      path.endsWith("/versions")
        ? Response.json(
            history("version-1", [
              { id: "version-1", file: { fieldId: "field-1" } },
            ]),
          )
        : Response.json(delivered(DOCX, { encrypted: true })),
    );
    const result = await read(fetch);
    expect(result.isOk() && result.value.viewer).toBe("quick-look");
  });

  test("says when the document has no file", async () => {
    const { fetch, calls } = server(() =>
      Response.json(history(null, [{ id: "version-1", file: null }])),
    );
    const result = await read(fetch);
    expect(result.isErr() && result.error._tag).toBe("NoFileError");
    expect(calls).toHaveLength(1);
  });

  test("tells no connection apart from a refusal", async () => {
    const offline = await read(async () => {
      throw new TypeError("Network request failed");
    });
    expect(offline.isErr() && isOffline(offline.error)).toBe(true);

    const { fetch } = server(() =>
      Response.json({ message: "Forbidden" }, { status: 403 }),
    );
    const refused = await read(fetch);
    expect(refused.isErr() && isOffline(refused.error)).toBe(false);
  });
});
