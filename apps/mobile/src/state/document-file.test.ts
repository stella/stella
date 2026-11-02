import { describe, expect, test } from "bun:test";

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
  versions: { id: string; file: { fieldId: string } | null }[],
) => ({
  entityId: "entity-1",
  currentVersionId,
  versions: versions.map((version) => ({
    ...version,
    versionNumber: 1,
    file:
      version.file === null
        ? null
        : {
            ...version.file,
            propertyId: "property-1",
            fileName: "Smlouva.docx",
            mimeType: DOCX,
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
