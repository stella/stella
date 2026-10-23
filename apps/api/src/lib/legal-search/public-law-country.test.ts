import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_UNAVAILABLE_CODE,
  PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
  publicCountryUnavailable,
} from "@stll/api-contract/public-country-capability";
import type { PublicCountryUnavailable } from "@stll/api-contract/public-country-capability";

import { apiPipeline } from "@/api/api-pipeline";
import { apiRoutes } from "@/api/api-routes";
import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";
import { createHttpApp } from "@/api/http/app";
import { mount, routes } from "@/api/http/route";
import type { RouteEntry } from "@/api/http/route";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  isSafePublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import {
  isValibotSchema,
  toRouteJsonSchema,
} from "@/api/lib/json-schema/valibot-to-json-schema";
import {
  publicCountryUnavailableAnswer,
  readPublicLawCountry,
  withPublicCountryUnavailable,
} from "@/api/lib/legal-search/public-law-country";
import { resetFailureObservationsForTesting } from "@/api/lib/observability/failure-shadow";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";

const pendingCountry = PUBLIC_COUNTRIES.find(
  (country) => PUBLIC_COUNTRY_CAPABILITIES[country].legislation !== "admitted",
);

// Built through the owner rather than read from the capability map, so the
// lifecycle is proven even once every advertised country is admitted.
const constructedRefusal: PublicCountryUnavailable = {
  code: PUBLIC_COUNTRY_UNAVAILABLE_CODE,
  domain: "caseLaw",
  status: "unavailable",
  country: PUBLIC_COUNTRIES.at(0) ?? panic("No advertised public country"),
  reason: "withdrawn",
  message: "Public law for this country is not available.",
  hint: "Choose an admitted country.",
};

const refusing = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "health_infra" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        v.object({ ok: v.boolean() }),
      ),
    ),
  },
  async function* () {
    return Result.ok(publicCountryUnavailableAnswer(constructedRefusal));
  },
);

// The production pipeline: request context, completion record and error
// answer, in front of the mounted routes.
const servePublicLaw = (): TestServer =>
  serveForTest(
    createHttpApp({
      middleware: apiPipeline,
      routes: [
        ...mount([publicLegislationRoute], { prefix: "/v1" }),
        ...routes({ "/v1/contacts/search": { GET: refusing } }),
      ],
    }),
  );

describe("typed public country unavailability through the request lifecycle", () => {
  let logs: RecordingLogger;

  beforeEach(() => {
    logs = installRecordingLogger();
    resetFailureObservationsForTesting();
  });

  afterEach(() => {
    logs.restore();
    resetFailureObservationsForTesting();
  });

  // The alarm-shaped question: would the completion record match a filter on
  // ERROR severity, or carry a defect grade?
  const expectAnsweredClientOutcome = () => {
    const completions = logs.records.filter(
      (record) => record.message === "request.completed",
    );
    expect(completions).toHaveLength(1);
    const completion = completions.at(0);
    expect(completion?.severityText).toBe("WARN");
    expect(completion?.attributes?.["http.status_code"]).toBe(
      PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
    );
    expect(completion?.attributes?.["failure.grade"]).toBeUndefined();
    expect(logs.at("ERROR")).toEqual([]);
  };

  test("an owner-built refusal answers its status and is not a server fault", async () => {
    await using server = servePublicLaw();
    const response = await server.fetch("http://localhost/v1/contacts/search");

    expect(response.status).toBe(PUBLIC_COUNTRY_UNAVAILABLE_STATUS);
    expect(await response.json()).toEqual(constructedRefusal);
    expectAnsweredClientOutcome();
  });

  test.if(pendingCountry !== undefined)(
    "a public statute search for a pending country answers the typed refusal",
    async () => {
      const country = pendingCountry ?? panic("No pending public country");
      await using server = servePublicLaw();
      const response = await server.fetch(
        `http://localhost/v1/law/statutes/search?country=${country}&query=synthetic`,
      );

      expect(response.status).toBe(PUBLIC_COUNTRY_UNAVAILABLE_STATUS);
      expect(await response.json()).toEqual(
        publicCountryUnavailable(country, {
          domain: "legislation",
          surface: "search",
        }),
      );
      expectAnsweredClientOutcome();
    },
  );
});

type SchemaNode = Record<string, unknown>;

const isSchemaNode = (value: unknown): value is SchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a response schema admits the refusal as its body, directly or as
 *  one branch of a union. A nested property (a batch item's availability) is
 *  data inside another answer, not this refusal. */
const declaresRefusal = (schema: unknown): boolean => {
  if (!isSchemaNode(schema)) {
    return false;
  }
  const properties = schema["properties"];
  if (
    isSchemaNode(properties) &&
    isSchemaNode(properties["code"]) &&
    properties["code"]["const"] === PUBLIC_COUNTRY_UNAVAILABLE_CODE
  ) {
    return true;
  }
  return ["anyOf", "oneOf"].some((keyword) => {
    const branches = schema[keyword];
    return Array.isArray(branches) && branches.some(declaresRefusal);
  });
};

const PUBLIC_LAW_PATH_PREFIXES = ["/v1/case/", "/v1/law/"] as const;
const COUNTRY_PARAMETERS = ["country", "jurisdiction"] as const;

/** A route schema as the JSON Schema agents and the census read. */
const rendered = (schema: unknown): unknown =>
  isValibotSchema(schema) ? toRouteJsonSchema(schema) : undefined;

/** The handler a safe factory built the route from, if any. */
const factoryHandler = (entry: RouteEntry): unknown =>
  "handler" in entry.definition ? entry.definition.handler : undefined;

/** A public law route whose request names one country at its top level. */
const namesPublicLawCountry = (entry: RouteEntry): boolean =>
  isSafePublicHandler(factoryHandler(entry)) &&
  PUBLIC_LAW_PATH_PREFIXES.some((prefix) => entry.path.startsWith(prefix)) &&
  [entry.definition.config.query, entry.definition.config.body].some(
    (schema) => {
      const json = rendered(schema);
      const properties = isSchemaNode(json) ? json["properties"] : undefined;
      return (
        isSchemaNode(properties) &&
        COUNTRY_PARAMETERS.some((parameter) => parameter in properties)
      );
    },
  );

describe("declared public country unavailability", () => {
  test("every mounted route declares the refusal only under its status, and every country-addressed public law route declares it", () => {
    const named = apiRoutes.map((entry) => ({
      name: `${entry.method} ${entry.path}`,
      entry,
    }));

    const declarations = named.flatMap(({ name, entry }) =>
      Object.entries(entry.definition.config.response ?? {})
        .filter(([, schema]) => declaresRefusal(rendered(schema)))
        .map(([status]) => ({ name, status })),
    );
    expect(declarations.length).toBeGreaterThan(0);
    expect(
      declarations.filter(
        ({ status }) => status !== String(PUBLIC_COUNTRY_UNAVAILABLE_STATUS),
      ),
    ).toEqual([]);

    const countryRoutes = named.filter(({ entry }) =>
      namesPublicLawCountry(entry),
    );
    expect(countryRoutes.length).toBeGreaterThan(0);
    const declaring = new Set(declarations.map(({ name }) => name));
    expect(
      countryRoutes
        .map(({ name }) => name)
        .filter((name) => !declaring.has(name)),
    ).toEqual([]);
  });
});

describe("a pages_public country on the shared read", () => {
  const capabilities = {
    ...PUBLIC_COUNTRY_CAPABILITIES,
    SVK: { ...PUBLIC_COUNTRY_CAPABILITIES.SVK, caseLaw: "pages_public" },
  } as const;
  const admitted = ["CZE", "SVK"];

  test("a page read succeeds", () => {
    expect(
      readPublicLawCountry("SVK", {
        domain: "caseLaw",
        admitted,
        capabilities,
        surface: "pages",
      }),
    ).toEqual({ kind: "read", country: "SVK" });
  });

  test("a search read stops with the unavailable answer before any query", () => {
    expect(
      readPublicLawCountry("SVK", {
        domain: "caseLaw",
        admitted,
        capabilities,
        surface: "search",
      }),
    ).toMatchObject({
      kind: "unavailable",
      answer: { response: { country: "SVK", reason: "pages_public" } },
    });
  });
});

test("EU provision jurisdiction does not depend on EU decision admission", () => {
  const capabilities = {
    ...PUBLIC_COUNTRY_CAPABILITIES,
    EU: { ...PUBLIC_COUNTRY_CAPABILITIES.EU, caseLaw: "withdrawn" as const },
  };
  for (const input of ["EU", "eu", "European Union"]) {
    expect(
      readPublicLawCountry(input, {
        domain: "caseLaw",
        admitted: ["CZE"],
        surface: "search",
        jurisdictionType: "provision",
        capabilities,
      }),
    ).toEqual({ kind: "read", country: "EU" });
    expect(
      readPublicLawCountry(input, {
        domain: "caseLaw",
        admitted: ["CZE"],
        surface: "search",
        capabilities,
      }).kind,
    ).toBe("unavailable");
  }
  expect(
    readPublicLawCountry("SVK", {
      domain: "caseLaw",
      admitted: ["CZE"],
      surface: "search",
      jurisdictionType: "provision",
      capabilities: {
        ...capabilities,
        SVK: { ...capabilities.SVK, caseLaw: "withdrawn" },
      },
    }).kind,
  ).toBe("unavailable");
});
