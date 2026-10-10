import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { expect, test } from "bun:test";
import Elysia, { status, t } from "elysia";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  createSafePublicHandler,
  isSafePublicHandler,
  safeHandlerResponseSchemasWithStatusText,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  projectPublicErrorBody,
  PUBLIC_ERROR_RESPONSE_MAX_BYTES,
  PUBLIC_ERROR_TEXT_BYTES,
  safePublicHandlerErrorResponseSchema,
} from "@/api/lib/search/public-error-response";

const text = fc
  .array(fc.constantFrom("😀", "ě", "e\u0301", "\u0000", "\ud800", '"', "\\"), {
    minLength: 1,
    maxLength: 64,
  })
  .map((parts) => parts.join("").repeat(128).padEnd(4096, "😀"));

const unboundedError = (value: string) => ({
  message: value,
  code: value,
  hint: value,
  contactUrl: value,
  retryable: true,
  country: value,
  status: value,
  reason: value,
  type: "conflict" as const,
  versions: Array.from({ length: 16 }, () => ({
    id: value,
    language: value,
    versionValidFrom: value,
    versionValidTo: value,
    basis: "reversed" as const,
  })),
  issues: Array.from({ length: 32 }, () => ({ path: value, message: value })),
  claim_token: value,
  arbitrary: value,
});

test("public error projection bounds serialized Unicode and issue collections", () => {
  assertProperty(
    "public error projection bounds serialized Unicode and issue collections",
    fc.property(text, (value) => {
      const input = unboundedError(value);
      expect(Buffer.byteLength(input.message)).toBeGreaterThan(
        PUBLIC_ERROR_TEXT_BYTES.message,
      );
      const projected = projectPublicErrorBody(input);
      expect(Value.Check(safePublicHandlerErrorResponseSchema, projected)).toBe(
        true,
      );
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(
        PUBLIC_ERROR_RESPONSE_MAX_BYTES,
      );
      expect(projected.versions?.length).toBe(
        PUBLIC_ERROR_TEXT_BYTES.versionCount,
      );
      expect(projected.issues?.length).toBe(PUBLIC_ERROR_TEXT_BYTES.issueCount);
      expect(projected).not.toHaveProperty("claim_token");
      expect(projected).not.toHaveProperty("arbitrary");
    }),
  );
});

const publicConfig = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
  cache: { kind: "none" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    t.Object({ ok: t.Boolean() }),
  ),
} as const;

const failureText = "😀\u0000".repeat(4096);

test("bounded public handlers bound both returned status errors and resolved handler errors on the wire", async () => {
  const returned = createSafeBoundedPublicHandler(
    publicConfig,
    async function* () {
      return Result.ok(
        status(503, {
          ...unboundedError(failureText),
          country: "SVK",
          status: "unavailable",
          reason: "pending_public",
        }),
      );
    },
  );
  const resolved = createSafeBoundedPublicHandler(
    publicConfig,
    async function* () {
      return Result.err(
        new HandlerError({
          status: 400,
          message: failureText,
          hint: failureText,
          issues: Array.from({ length: 32 }, () => ({
            path: failureText,
            message: failureText,
          })),
        }),
      );
    },
  );
  const statusText = createSafeBoundedPublicHandler(
    publicConfig,
    async function* () {
      return Result.ok(status(404, failureText));
    },
  );
  const legacy = createSafePublicHandler(
    {
      ...publicConfig,
      response: safeHandlerResponseSchemasWithStatusText(
        t.Object({ ok: t.Boolean() }),
      ),
    },
    async function* () {
      return Result.ok(
        status(400, {
          message: "Interaction required",
          claim_token: failureText,
        }),
      );
    },
  );
  const app = new Elysia()
    .get("/legacy", legacy.handler, legacy.config)
    .get("/returned", returned.handler, returned.config)
    .get("/resolved", resolved.handler, resolved.config)
    .get("/status-text", statusText.handler, statusText.config);
  for (const [path, expectedStatus] of [
    ["/returned", 503],
    ["/resolved", 400],
  ] as const) {
    const response = await app.handle(new Request(`http://localhost${path}`));
    expect(response.status).toBe(expectedStatus);
    const bytes = await response.text();
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(
      PUBLIC_ERROR_RESPONSE_MAX_BYTES,
    );
    const body: unknown = JSON.parse(bytes);
    expect(Value.Check(safePublicHandlerErrorResponseSchema, body)).toBe(true);
    expect(body).not.toHaveProperty("claim_token");
    if (path === "/returned") {
      expect(body).toMatchObject({
        country: "SVK",
        status: "unavailable",
        reason: "pending_public",
      });
    }
  }
  const legacyResponse = await app.handle(
    new Request("http://localhost/legacy"),
  );
  expect(legacyResponse.status).toBe(400);
  expect(await legacyResponse.json()).toHaveProperty(
    "claim_token",
    failureText,
  );
  const response = await app.handle(
    new Request("http://localhost/status-text"),
  );
  expect(response.status).toBe(404);
  expect(Buffer.byteLength(await response.text())).toBeLessThanOrEqual(
    PUBLIC_ERROR_TEXT_BYTES.statusText,
  );
});

const configFor = <TSuccess extends TSchema>(success: TSuccess) => ({
  ...publicConfig,
  response: safePublicHandlerResponseSchemasWithStatusText(success),
});
const DECISION_ID = toSafeId<"caseLawDecision">(
  "01900000-0000-7000-8000-000000000000",
);
const PAGE = { limit: 50 } as const;

test("bounded public handlers bind the 200 schema to the payload both ways", () => {
  const nonGenerator = createSafeBoundedPublicHandler(
    configFor(t.Object({ id: t.String() })),
    // @ts-expect-error - safe handlers must be async generators
    async () => Result.ok({ id: "entry" }),
  );
  const invalidYield = createSafeBoundedPublicHandler(
    // @ts-expect-error - intermediate values must be typed failures
    configFor(t.Object({ id: t.String() })),
    async function* () {
      yield "invalid";
      return Result.ok({ id: "entry" });
    },
  );
  void nonGenerator;
  void invalidYield;
  const undefinedPayload = createSafeBoundedPublicHandler(
    // @ts-expect-error - successful handlers must return a non-nullish payload
    configFor(t.Object({ id: t.String() })),
    async function* () {
      return Result.ok(undefined);
    },
  );
  const plainPayload = createSafeBoundedPublicHandler(
    // @ts-expect-error - a handler must return a Result rather than a plain object
    configFor(t.Object({ id: t.String() })),
    async function* () {
      return { id: "entry" };
    },
  );
  const missingPayload = createSafeBoundedPublicHandler(
    // @ts-expect-error - an empty inferred payload cannot satisfy the id schema
    configFor(t.Object({ id: t.String() })),
    async function* () {
      return Result.ok({});
    },
  );
  const brandWidened = createSafeBoundedPublicHandler(
    // @ts-expect-error - a plain string schema misdescribes a branded id
    configFor(t.Object({ id: t.String() })),
    async function* () {
      return Result.ok({ id: DECISION_ID });
    },
  );
  const nullableWidened = createSafeBoundedPublicHandler(
    // @ts-expect-error - the data is never null
    configFor(
      t.Object({ id: t.Union([tSafeId("caseLawDecision"), t.Null()]) }),
    ),
    async function* () {
      return Result.ok({ id: DECISION_ID });
    },
  );
  const literalWidened = createSafeBoundedPublicHandler(
    // @ts-expect-error - the data is one fixed limit
    configFor(t.Object({ limit: t.Number() })),
    async function* () {
      return Result.ok({ limit: PAGE.limit });
    },
  );
  const keyDropped = createSafeBoundedPublicHandler(
    // @ts-expect-error - Elysia would strip `extra` from the wire
    configFor(t.Object({ ok: t.Boolean() })),
    async function* () {
      return Result.ok({ ok: true, extra: 1 });
    },
  );
  const readonlyOnly = createSafeBoundedPublicHandler(
    configFor(
      t.Object({
        id: tSafeId("caseLawDecision"),
        limit: t.Literal(PAGE.limit),
        tags: t.Array(t.String()),
      }),
    ),
    async function* () {
      const tags: readonly string[] = ["a"];
      return Result.ok({ id: DECISION_ID, limit: PAGE.limit, tags });
    },
  );
  // The cases are compile-time; each definition still registers at runtime.
  for (const definition of [
    undefinedPayload,
    plainPayload,
    missingPayload,
    brandWidened,
    nullableWidened,
    literalWidened,
    keyDropped,
    readonlyOnly,
  ]) {
    expect(isSafePublicHandler(definition.handler)).toBe(true);
  }
});
