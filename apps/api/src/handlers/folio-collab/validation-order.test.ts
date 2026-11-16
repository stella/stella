import { afterAll, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { folioCollabRoute } from "@/api/handlers/folio-collab/routes";
import { createHttpApp } from "@/api/http/app";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

// The folio-collab room endpoints authorize themselves from either a
// caller-supplied room credential or a deployment service credential. Their route schemas
// are deliberately permissive, so framework validation can never answer a
// probe before the handler's own credential check: a request with malformed
// credentials must match the endpoint's auth-shaped failure, never a 422 that
// leaks parameter shape. These tests never present a
// well-formed credential pair, so no request reaches the database.

// The routes without their address budget: every probe below comes from one
// address, and the budget's own refusal is the rate-limit tests' subject.
const app = serveForTest(
  createHttpApp({
    routes: folioCollabRoute.map((entry) => ({ ...entry, middleware: [] })),
    middleware: [errorBoundary],
  }),
);
afterAll(async () => {
  await app.stop();
});

const VALID_UUID = "0198c0de-0000-4000-8000-000000000000";
const WELL_FORMED_TOKEN = "a".repeat(64);

const NOT_FOUND_BODY = { message: "Collaborative editing room not found." };

const jsonRequest = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const expectAuthShapedFailure = async (
  request: Request,
  expected: { body: { message: string }; status: 401 | 404 },
) => {
  const response = await app.fetch(request);
  expect(response.status).toBe(expected.status);
  // The handler's own auth failure, not a validation error (which would
  // carry the validation code and the failing fields).
  expect(await response.json()).toEqual(expected.body);
};

const serviceAuthFailure =
  env.STELLA_COLLAB_SERVICE_TOKEN === undefined
    ? { body: { message: "Not available" }, status: 404 as const }
    : {
        body: { message: "Invalid collaboration service token" },
        status: 401 as const,
      };

const credentialPaths = [
  {
    expected: { body: NOT_FOUND_BODY, status: 404 as const },
    path: "/folio-collab-rooms/snapshot/seed",
  },
  {
    expected: { body: NOT_FOUND_BODY, status: 404 as const },
    path: "/folio-collab-rooms/authorize",
  },
  {
    expected: { body: NOT_FOUND_BODY, status: 404 as const },
    path: "/folio-collab-rooms/refresh-token",
  },
  {
    expected: { body: NOT_FOUND_BODY, status: 404 as const },
    path: "/folio-collab-rooms/heartbeat",
  },
  {
    expected: serviceAuthFailure,
    path: "/folio-collab-rooms/snapshot/load",
  },
  {
    expected: serviceAuthFailure,
    path: "/folio-collab-rooms/snapshot/store",
  },
];

describe("folio-collab probes with malformed bodies never see validation errors", () => {
  test.each(credentialPaths)(
    "POST %s: malformed bodies answer with auth failure, not 422",
    async ({ expected, path }) => {
      // No body at all.
      await expectAuthShapedFailure(
        new Request(`http://localhost${path}`, { method: "POST" }),
        expected,
      );
      // Empty object: credentials absent.
      await expectAuthShapedFailure(jsonRequest(path, {}), expected);
      // Token of the wrong length.
      await expectAuthShapedFailure(
        jsonRequest(path, { roomId: VALID_UUID, token: "short" }),
        expected,
      );
      // Session id that is not even a UUID.
      await expectAuthShapedFailure(
        jsonRequest(path, { roomId: "garbage", token: WELL_FORMED_TOKEN }),
        expected,
      );
      // Non-string JSON values must reach the handler too; otherwise the
      // permissive route schema itself leaks a 422 before authorization.
      await expectAuthShapedFailure(
        jsonRequest(path, { roomId: [], token: 0 }),
        expected,
      );
      await expectAuthShapedFailure(
        jsonRequest(path, { roomId: true, token: {} }),
        expected,
      );
      // Non-object JSON roots must also reach the handler. An object-only
      // route schema would reject these before credential authorization.
      await expectAuthShapedFailure(jsonRequest(path, null), expected);
      await expectAuthShapedFailure(jsonRequest(path, []), expected);
      await expectAuthShapedFailure(jsonRequest(path, 0), expected);
      await expectAuthShapedFailure(jsonRequest(path, "probe"), expected);
      // Unknown extra keys alongside malformed credentials.
      await expectAuthShapedFailure(
        jsonRequest(path, { token: "x", probe: "1", admin: "true" }),
        expected,
      );
      // Unparseable JSON cannot be read as the content type it declares, so
      // the HTTP layer answers its generic 400 before any route code runs:
      // the same fixed body every route sends, naming no field or schema.
      const unparseable = await app.fetch(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
      );
      expect(unparseable.status).toBe(400);
      expect(await unparseable.json()).toEqual({
        message: "Malformed request",
      });
      // Non-JSON content type.
      await expectAuthShapedFailure(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "garbage",
        }),
        expected,
      );
    },
  );
});
