import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { folioCollabRoute } from "@/api/handlers/folio-collab/routes";

// The folio-collab session endpoints authorize themselves from a
// caller-supplied credential pair (sessionId + token). Their route schemas
// are deliberately permissive, so framework validation can never answer a
// probe before the handler's own credential check: a request with malformed
// credentials must be byte-identical to one with unknown credentials (404),
// never a 422 that leaks parameter shape. These tests never present a
// well-formed credential pair, so no request reaches the database.

const app = new Elysia().use(folioCollabRoute);

const VALID_UUID = "0198c0de-0000-4000-8000-000000000000";
const WELL_FORMED_TOKEN = "a".repeat(64);

const NOT_FOUND_BODY = { message: "Collaborative edit session not found." };

const jsonRequest = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const expectAuthShapedNotFound = async (request: Request) => {
  const response = await app.handle(request);
  expect(response.status).toBe(404);
  // The handler's own auth failure, not an Elysia validation error
  // (which would carry `type: "validation"` and the schema summary).
  expect(await response.json()).toEqual(NOT_FOUND_BODY);
};

const bodyCredentialPaths = [
  "/folio-collab-sessions/authorize",
  "/folio-collab-sessions/refresh-token",
  "/folio-collab-sessions/snapshot/load",
  "/folio-collab-sessions/snapshot/store",
];

const paramCredentialPaths = [
  `/folio-collab-sessions/${VALID_UUID}/cancel`,
  `/folio-collab-sessions/${VALID_UUID}/checkpoint`,
  `/folio-collab-sessions/${VALID_UUID}/finalize`,
];

const garbageParamPaths = [
  "/folio-collab-sessions/not-a-uuid/cancel",
  "/folio-collab-sessions/not-a-uuid/checkpoint",
  "/folio-collab-sessions/not-a-uuid/finalize",
];

describe("folio-collab probes with malformed bodies never see validation errors", () => {
  test.each(bodyCredentialPaths)(
    "POST %s: malformed credential bodies answer 404, not 422",
    async (path) => {
      // No body at all.
      await expectAuthShapedNotFound(
        new Request(`http://localhost${path}`, { method: "POST" }),
      );
      // Empty object: credentials absent.
      await expectAuthShapedNotFound(jsonRequest(path, {}));
      // Token of the wrong length.
      await expectAuthShapedNotFound(
        jsonRequest(path, { sessionId: VALID_UUID, token: "short" }),
      );
      // Session id that is not even a UUID.
      await expectAuthShapedNotFound(
        jsonRequest(path, { sessionId: "garbage", token: WELL_FORMED_TOKEN }),
      );
      // Unknown extra keys alongside malformed credentials.
      await expectAuthShapedNotFound(
        jsonRequest(path, { token: "x", probe: "1", admin: "true" }),
      );
      // Unparseable JSON.
      await expectAuthShapedNotFound(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
      );
      // Non-JSON content type.
      await expectAuthShapedNotFound(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "garbage",
        }),
      );
    },
  );

  test.each(paramCredentialPaths)(
    "POST %s: malformed token bodies answer 404, not 422",
    async (path) => {
      await expectAuthShapedNotFound(
        new Request(`http://localhost${path}`, { method: "POST" }),
      );
      await expectAuthShapedNotFound(jsonRequest(path, {}));
      await expectAuthShapedNotFound(jsonRequest(path, { token: "short" }));
    },
  );

  test.each(garbageParamPaths)(
    "POST %s: a non-UUID session id in the path answers 404, not 422",
    async (path) => {
      await expectAuthShapedNotFound(
        jsonRequest(path, { token: WELL_FORMED_TOKEN }),
      );
    },
  );

  test("checkpoint: a multipart probe without a valid token answers 404 before any file handling", async () => {
    const form = new FormData();
    form.append("token", "short");
    form.append(
      "file",
      new File([new Uint8Array([0x50, 0x4b])], "probe.docx", {
        type: "application/zip",
      }),
    );
    await expectAuthShapedNotFound(
      new Request(
        `http://localhost/folio-collab-sessions/${VALID_UUID}/checkpoint`,
        { method: "POST", body: form },
      ),
    );
  });
});
