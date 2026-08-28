import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { folioCollabRoute } from "@/api/handlers/folio-collab/routes";

// The folio-collab room endpoints authorize themselves from either a
// caller-supplied room credential or a deployment service credential. Their route schemas
// are deliberately permissive, so framework validation can never answer a
// probe before the handler's own credential check: a request with malformed
// credentials must be byte-identical to one with unknown credentials (404),
// never a 422 that leaks parameter shape. These tests never present a
// well-formed credential pair, so no request reaches the database.

const app = new Elysia().use(folioCollabRoute);

const VALID_UUID = "0198c0de-0000-4000-8000-000000000000";
const WELL_FORMED_TOKEN = "a".repeat(64);

const NOT_FOUND_BODY = { message: "Collaborative editing room not found." };

const jsonRequest = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const expectAuthShapedNotFound = async (
  request: Request,
  expectedBody = NOT_FOUND_BODY,
) => {
  const response = await app.handle(request);
  expect(response.status).toBe(404);
  // The handler's own auth failure, not an Elysia validation error
  // (which would carry `type: "validation"` and the schema summary).
  expect(await response.json()).toEqual(expectedBody);
};

const credentialPaths = [
  {
    expectedBody: NOT_FOUND_BODY,
    path: "/folio-collab-rooms/authorize",
  },
  {
    expectedBody: NOT_FOUND_BODY,
    path: "/folio-collab-rooms/refresh-token",
  },
  {
    expectedBody: NOT_FOUND_BODY,
    path: "/folio-collab-rooms/heartbeat",
  },
  {
    expectedBody: { message: "Not available" },
    path: "/folio-collab-rooms/snapshot/load",
  },
  {
    expectedBody: { message: "Not available" },
    path: "/folio-collab-rooms/snapshot/store",
  },
];

describe("folio-collab probes with malformed bodies never see validation errors", () => {
  test.each(credentialPaths)(
    "POST %s: malformed credential bodies answer 404, not 422",
    async ({ expectedBody, path }) => {
      // No body at all.
      await expectAuthShapedNotFound(
        new Request(`http://localhost${path}`, { method: "POST" }),
        expectedBody,
      );
      // Empty object: credentials absent.
      await expectAuthShapedNotFound(jsonRequest(path, {}), expectedBody);
      // Token of the wrong length.
      await expectAuthShapedNotFound(
        jsonRequest(path, { roomId: VALID_UUID, token: "short" }),
        expectedBody,
      );
      // Session id that is not even a UUID.
      await expectAuthShapedNotFound(
        jsonRequest(path, { roomId: "garbage", token: WELL_FORMED_TOKEN }),
        expectedBody,
      );
      // Non-string JSON values must reach the handler too; otherwise the
      // permissive route schema itself leaks a 422 before authorization.
      await expectAuthShapedNotFound(
        jsonRequest(path, { roomId: [], token: 0 }),
        expectedBody,
      );
      await expectAuthShapedNotFound(
        jsonRequest(path, { roomId: true, token: {} }),
        expectedBody,
      );
      // Non-object JSON roots must also reach the handler. An object-only
      // route schema would reject these before credential authorization.
      await expectAuthShapedNotFound(jsonRequest(path, null), expectedBody);
      await expectAuthShapedNotFound(jsonRequest(path, []), expectedBody);
      await expectAuthShapedNotFound(jsonRequest(path, 0), expectedBody);
      await expectAuthShapedNotFound(jsonRequest(path, "probe"), expectedBody);
      // Unknown extra keys alongside malformed credentials.
      await expectAuthShapedNotFound(
        jsonRequest(path, { token: "x", probe: "1", admin: "true" }),
        expectedBody,
      );
      // Unparseable JSON.
      await expectAuthShapedNotFound(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        expectedBody,
      );
      // Non-JSON content type.
      await expectAuthShapedNotFound(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "garbage",
        }),
        expectedBody,
      );
    },
  );
});
