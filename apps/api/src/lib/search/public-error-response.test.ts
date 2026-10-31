import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_LAW_DOMAINS,
  publicCountryUnavailableIn,
  publicCountryUnavailableSchema,
} from "@stll/api-contract/public-country-capability";
import { assertProperty } from "@stll/property-testing";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  createSafePublicHandler,
  isSafePublicHandler,
  safeHandlerResponseSchemasWithStatusText,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  projectPublicErrorBody,
  PUBLIC_ERROR_RESPONSE_MAX_BYTES,
  PUBLIC_ERROR_TEXT_BYTES,
  safePublicHandlerErrorResponseSchema,
} from "@/api/lib/search/public-error-response";
import { serveForTest } from "@/api/tests/helpers/test-server";

const text = fc
  .array(fc.constantFrom("😀", "ě", "é", "\u0000", "\ud800", '"', "\\"), {
    minLength: 1,
    maxLength: 64,
  })
  .map((parts) => parts.join("").repeat(128).padEnd(4096, "😀"));

const unboundedError = (value: string) => ({
  message: value,
  code: value,
  hint: value,
  contactUrl: value,
  domain: value,
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
    fc.property(
      text,
      fc.constantFrom(...PUBLIC_LAW_DOMAINS),
      (value, domain) => {
        const input = unboundedError(value);
        expect(Buffer.byteLength(input.message)).toBeGreaterThan(
          PUBLIC_ERROR_TEXT_BYTES.message,
        );
        expect(projectPublicErrorBody(input)).not.toHaveProperty("domain");
        const projected = projectPublicErrorBody({ ...input, domain });
        expect(projected.domain).toBe(domain);
        expect(v.is(safePublicHandlerErrorResponseSchema, projected)).toBe(
          true,
        );
        expect(
          Buffer.byteLength(JSON.stringify(projected)),
        ).toBeLessThanOrEqual(PUBLIC_ERROR_RESPONSE_MAX_BYTES);
        expect(projected.versions?.length).toBe(
          PUBLIC_ERROR_TEXT_BYTES.versionCount,
        );
        expect(projected.issues?.length).toBe(
          PUBLIC_ERROR_TEXT_BYTES.issueCount,
        );
        expect(projected).not.toHaveProperty("claim_token");
        expect(projected).not.toHaveProperty("arbitrary");
      },
    ),
  );
});

test("canonical country refusals are fixed points of public error projection", () => {
  for (const country of PUBLIC_COUNTRIES) {
    for (const reason of publicCountryUnavailableSchema.entries.reason
      .options) {
      for (const domain of PUBLIC_LAW_DOMAINS) {
        const refusal = publicCountryUnavailableIn({
          capabilities: {
            ...PUBLIC_COUNTRY_CAPABILITIES,
            [country]: { caseLaw: reason, legislation: reason },
          },
          domain,
          input: country,
          surface: "search",
        });
        expect(refusal).not.toBeNull();
        if (refusal === null) {
          panic("Expected a refusal for a closed public-law domain");
        }
        expect(projectPublicErrorBody(refusal)).toEqual(refusal);
      }
    }
  }
});

const publicConfig = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
  cache: { kind: "none" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    v.object({ ok: v.boolean() }),
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
          domain: "caseLaw",
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
        v.object({ ok: v.boolean() }),
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
  await using server = serveForTest(
    createHttpApp({
      middleware: [],
      routes: routes({
        "/legacy": { GET: legacy },
        "/returned": { GET: returned },
        "/resolved": { GET: resolved },
        "/status-text": { GET: statusText },
      }),
    }),
  );
  for (const [path, expectedStatus] of [
    ["/returned", 503],
    ["/resolved", 400],
  ] as const) {
    const response = await server.fetch(`http://localhost${path}`);
    expect(response.status).toBe(expectedStatus);
    const bytes = await response.text();
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(
      PUBLIC_ERROR_RESPONSE_MAX_BYTES,
    );
    const body: unknown = JSON.parse(bytes);
    expect(v.is(safePublicHandlerErrorResponseSchema, body)).toBe(true);
    expect(body).not.toHaveProperty("claim_token");
    if (path === "/returned") {
      expect(body).toMatchObject({
        country: "SVK",
        domain: "caseLaw",
        status: "unavailable",
        reason: "pending_public",
      });
    } else {
      expect(body).not.toHaveProperty("domain");
    }
  }
  const legacyResponse = await server.fetch("http://localhost/legacy");
  expect(legacyResponse.status).toBe(400);
  expect(await legacyResponse.json()).toHaveProperty(
    "claim_token",
    failureText,
  );
  const response = await server.fetch("http://localhost/status-text");
  expect(response.status).toBe(404);
  expect(Buffer.byteLength(await response.text())).toBeLessThanOrEqual(
    PUBLIC_ERROR_TEXT_BYTES.statusText,
  );
});

const configFor = <TSuccess extends v.GenericSchema>(success: TSuccess) => ({
  ...publicConfig,
  response: safePublicHandlerResponseSchemasWithStatusText(success),
});
const DECISION_ID = toSafeId<"caseLawDecision">(
  "01900000-0000-7000-8000-000000000000",
);
const PAGE = { limit: 50 } as const;

test("bounded public handlers bind the 200 schema to the payload both ways", () => {
  const brandWidened = createSafeBoundedPublicHandler(
    configFor(v.object({ id: v.string() })),
    // @ts-expect-error - a plain string schema misdescribes a branded id
    async function* () {
      return Result.ok({ id: DECISION_ID });
    },
  );
  const nullableWidened = createSafeBoundedPublicHandler(
    configFor(
      v.object({ id: v.nullable(resourceIdSchema("caseLawDecision")) }),
    ),
    // @ts-expect-error - the data is never null
    async function* () {
      return Result.ok({ id: DECISION_ID });
    },
  );
  const literalWidened = createSafeBoundedPublicHandler(
    configFor(v.object({ limit: v.number() })),
    // @ts-expect-error - the data is one fixed limit
    async function* () {
      return Result.ok({ limit: PAGE.limit });
    },
  );
  const keyDropped = createSafeBoundedPublicHandler(
    configFor(v.object({ ok: v.boolean() })),
    // @ts-expect-error - the response schema would drop `extra` from the wire
    async function* () {
      return Result.ok({ ok: true, extra: 1 });
    },
  );
  const readonlyOnly = createSafeBoundedPublicHandler(
    configFor(
      v.object({
        id: resourceIdSchema("caseLawDecision"),
        limit: v.literal(PAGE.limit),
        tags: v.array(v.string()),
      }),
    ),
    async function* () {
      const tags: readonly string[] = ["a"];
      return Result.ok({ id: DECISION_ID, limit: PAGE.limit, tags });
    },
  );
  // The cases are compile-time; each definition still registers at runtime.
  for (const definition of [
    brandWidened,
    nullableWidened,
    literalWidened,
    keyDropped,
    readonlyOnly,
  ]) {
    expect(isSafePublicHandler(definition.handler)).toBe(true);
  }
});
