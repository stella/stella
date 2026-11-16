import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
} from "@/connection/session";
import type { StoredSession } from "@/connection/session";

import {
  pickedFileSaveParams,
  readFileProperty,
  UPLOAD_ORIGIN,
  uploadDocument,
} from "./document-upload";

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

const STORAGE = "https://bucket.example.com/tmp/upload-1?X-Amz-Signature=s";

const FILE = {
  uri: "file:///tmp/scan.pdf",
  mimeType: "application/pdf",
  size: 4,
  sha256Hex: "a".repeat(64),
};

/** A server and a storage bucket that record each request, the bucket answering `storage`. */
const world = (storage: number) => {
  const requests: string[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = input;
    const method = init?.method ?? "GET";
    if (url === FILE.uri) {
      return new Response("%PDF");
    }
    if (url === STORAGE) {
      const headers = new Headers(init?.headers);
      requests.push(
        `${method} storage ${headers.get("x-amz-checksum-sha256") ?? "unsigned"}`,
      );
      return new Response(null, { status: storage });
    }
    const path = url.replace(SESSION.serverUrl, "");
    const body = typeof init?.body === "string" ? ` ${init.body}` : "";
    requests.push(`${method} ${path}${body}`);
    if (path === "/v1/properties/m1") {
      return Response.json([
        { id: "p-title", content: { type: "text" } },
        { id: "p-docs", content: { type: "file" } },
      ]);
    }
    if (path.endsWith("/presign")) {
      return Response.json({
        uploadId: "u1",
        url: STORAGE,
        expiresAt: "2026-10-28T10:05:00.000Z",
        headers: { "x-amz-checksum-sha256": "c2lnbmVk" },
      });
    }
    if (path.endsWith("/finalize")) {
      return Response.json({
        finalizedResult: { type: "entity_create", entityId: "e1" },
      });
    }
    return Response.json({ ok: true });
  };
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  const source = createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store,
    generation: store.generation(),
  });
  return { fetch, requests, source };
};

describe("uploading a document", () => {
  test("finds the matter's documents column", async () => {
    const { fetch, source } = world(200);
    const property = await readFileProperty({ fetch, matterId: "m1", source });
    expect(property.isOk() ? property.value : property.error).toBe("p-docs");
  });

  test("signs, sends and records the file, in that order", async () => {
    const { fetch, requests, source } = world(200);
    const uploaded = await uploadDocument({
      fetch,
      file: FILE,
      matterId: "m1",
      name: "Scan.pdf",
      propertyId: "p-docs",
      source,
    });
    expect(uploaded.isOk() ? uploaded.value : uploaded.error).toBe("e1");
    expect(requests).toEqual([
      `POST /v1/uploads/m1/presign {"purpose":"entity_create","propertyId":"p-docs","parentId":null,"name":"Scan.pdf","mimeType":"application/pdf","size":4,"sha256Hex":"${FILE.sha256Hex}"}`,
      "PUT storage c2lnbmVk",
      "POST /v1/uploads/m1/u1/finalize",
    ]);
  });

  test("a refused transfer withdraws the upload and records nothing", async () => {
    const { fetch, requests, source } = world(403);
    const uploaded = await uploadDocument({
      fetch,
      file: FILE,
      matterId: "m1",
      name: "Scan.pdf",
      propertyId: "p-docs",
      source,
    });
    expect(uploaded.isErr()).toBe(true);
    expect(requests.slice(1)).toEqual([
      "PUT storage c2lnbmVk",
      "POST /v1/uploads/m1/u1/abort",
    ]);
  });
});

describe("a picked file's save sheet", () => {
  test("keeps a non-PDF's type, size, digest and the matter it was picked for", () => {
    expect(
      pickedFileSaveParams({
        file: {
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          name: "Dodatek č. 1.docx",
          uri: "file:///cache/Dodatek.docx",
        },
        matterId: "matter-1",
        sha256Hex: "ab".repeat(32),
        size: 48_213,
      }),
    ).toEqual({
      matterId: "matter-1",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "Dodatek č. 1.docx",
      origin: UPLOAD_ORIGIN.file,
      sha256Hex: "ab".repeat(32),
      size: "48213",
      uri: "file:///cache/Dodatek.docx",
    });
  });

  test("leaves the matter to the sheet when none was given, and names an untyped file a byte stream", () => {
    const params = pickedFileSaveParams({
      file: { name: "export", uri: "file:///cache/export" },
      matterId: undefined,
      sha256Hex: "00".repeat(32),
      size: 0,
    });
    expect(params).not.toHaveProperty("matterId");
    expect(params.mimeType).toBe("application/octet-stream");
  });
});
