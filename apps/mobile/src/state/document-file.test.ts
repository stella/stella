import { describe, expect, test } from "bun:test";
import type { InferOutput } from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import type { asicPreviewSchema } from "@stll/api-contract/asic";
import type { CertifiedEmailRead } from "@stll/api-contract/certified-email";
import {
  DATA_BOX_DOCUMENT_KIND,
  DATA_BOX_MESSAGE_MIME_TYPE,
} from "@stll/api-contract/data-box";

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
  readDocumentFile,
  readOriginalDocumentFile,
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
    file: { fieldId: string; fileName?: string; mimeType?: string } | null;
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
            ...version.file,
            sizeBytes: 1200,
          },
  })),
});

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
    });
    expect(calls).toEqual([
      "/v1/entities/matter-1/entity/entity-1/versions",
      "/v1/files/matter-1/url/field-1?purpose=display",
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
      });
      expect(file.fileName).toBe(fileName);
      expect(calls).toEqual([
        "/v1/entities/matter-1/entity/entity-1/versions",
        "/v1/files/matter-1/data-box/field%3F1",
      ]);
    },
  );

  const certifiedRead = {
    envelope: {
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
      provider: "Example PEC provider",
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
    text: "Subject: Notifica\nSi trasmette l'atto.",
    attachments: [{ fileName: "atto.pdf", sizeBytes: 2048 }],
  } satisfies CertifiedEmailRead;

  test("opens an .eml its content shows to be a certified email through the audited reading", async () => {
    const { fetch, calls } = server((path) =>
      Response.json(
        path.endsWith("/versions")
          ? legalFileVersion("Consegna.eml", "message/rfc822")
          : certifiedRead,
      ),
    );
    const file = (await read(fetch)).unwrap();
    expect(file.viewer === "certifiedEmail" && file.preview.unwrap()).toEqual(
      certifiedRead,
    );
    expect(calls).toEqual([
      "/v1/entities/matter-1/entity/entity-1/versions",
      "/v1/files/matter-1/certified-email/field%3F1",
    ]);
  });

  test("opens any other .eml as before once the server says it is not certified", async () => {
    const { fetch, calls } = server((path) => {
      if (path.endsWith("/versions")) {
        return Response.json(legalFileVersion("Lettera.eml", "message/rfc822"));
      }
      return path.includes("/certified-email/")
        ? Response.json(
            { code: PREVIEW_UNAVAILABLE_ERROR_CODE, message: "Not certified" },
            { status: 422 },
          )
        : Response.json(delivered("application/pdf"));
    });
    const file = (await read(fetch)).unwrap();
    expect(file.viewer).toBe("pdf");
    expect(calls).toEqual([
      "/v1/entities/matter-1/entity/entity-1/versions",
      "/v1/files/matter-1/certified-email/field%3F1",
      "/v1/files/matter-1/url/field%3F1?purpose=display",
    ]);
  });

  test("keeps a certified email's failed reading for a retry", async () => {
    const { fetch } = server((path) =>
      path.endsWith("/versions")
        ? Response.json(legalFileVersion("Consegna.eml", "message/rfc822"))
        : Response.json({ message: "Unavailable" }, { status: 503 }),
    );
    const file = (await read(fetch)).unwrap();
    expect(file.viewer).toBe("certifiedEmail");
    expect(file.viewer === "certifiedEmail" && file.preview.isErr()).toBe(true);
  });

  test("never asks an Outlook message for a certified reading", async () => {
    const { fetch, calls } = server((path) =>
      path.endsWith("/versions")
        ? Response.json(
            legalFileVersion("Lettera.msg", "application/vnd.ms-outlook"),
          )
        : Response.json(delivered("application/pdf")),
    );
    await read(fetch);
    expect(calls.some((path) => path.includes("/certified-email/"))).toBe(
      false,
    );
  });

  test.each([
    {
      fileName: "Verbale.pdf",
      mimeType: "application/pdf",
      text: "Il testo del verbale",
    },
    {
      fileName: "Allegato.bin",
      mimeType: "application/octet-stream",
      text: "",
    },
  ])(
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

  test.each([".ASICE", ".sce", ".bdoc", ".asics", ".scs"])(
    "reads an ASiC archive with the %s extension through the preview",
    async (extension) => {
      const fileName = `appendices${extension}`;
      const preview = {
        members: [
          {
            fileName: "submission.pdf",
            status: "readable",
            text: "The enclosed submission",
          },
          { fileName: "attachment.bin", status: "unavailable", text: "" },
          {
            fileName: "notes.txt",
            status: "truncated",
            text: "The first page",
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
