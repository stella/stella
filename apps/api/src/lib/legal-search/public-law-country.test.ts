import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import {
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_UNAVAILABLE_CODE,
  PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
  publicCountryUnavailable,
} from "@stll/api-contract/public-country-capability";
import type { PublicCountryUnavailable } from "@stll/api-contract/public-country-capability";

import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  isSafePublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import {
  publicCountryUnavailableAnswer,
  withPublicCountryUnavailable,
} from "@/api/lib/legal-search/public-law-country";
import { resetFailureObservationsForTesting } from "@/api/lib/observability/failure-shadow";
import { initRequestContext } from "@/api/lib/observability/request-context";
import {
  answerRequestError,
  completeRequest,
} from "@/api/lib/observability/request-lifecycle";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const pendingCountry = PUBLIC_COUNTRIES.find(
  (country) => PUBLIC_COUNTRY_CAPABILITIES[country] !== "admitted",
);

// Built through the owner rather than read from the capability map, so the
// lifecycle is proven even once every advertised country is admitted.
const constructedRefusal: PublicCountryUnavailable = {
  code: PUBLIC_COUNTRY_UNAVAILABLE_CODE,
  status: "unavailable",
  country: PUBLIC_COUNTRIES.at(0) ?? panic("No advertised public country"),
  reason: "withdrawn",
  message: "Public law for this country is not available.",
  hint: "Choose an admitted country.",
};

const refusing = createSafeBoundedPublicHandler(
  {
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "health_infra" },
    cache: { kind: "none" },
    response: withPublicCountryUnavailable(
      safePublicHandlerResponseSchemasWithStatusText(
        t.Object({ ok: t.Boolean() }),
      ),
    ),
  },
  async function* () {
    return Result.ok(publicCountryUnavailableAnswer(constructedRefusal));
  },
);

// The production hook order: context, error answer, completion record, then
// the mounted routes.
const buildApp = () =>
  new Elysia()
    .onRequest(({ request }) => {
      initRequestContext(request);
    })
    .onError((context) => answerRequestError(context))
    .onAfterHandle(async (context) => await completeRequest(context))
    .use(publicLegislationRoute)
    .get("/refusing", refusing.handler, refusing.config);

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
    const response = await buildApp().handle(
      new Request("http://localhost/refusing"),
    );

    expect(response.status).toBe(PUBLIC_COUNTRY_UNAVAILABLE_STATUS);
    expect(await response.json()).toEqual(constructedRefusal);
    expectAnsweredClientOutcome();
  });

  test.if(pendingCountry !== undefined)(
    "a public statute search for a pending country answers the typed refusal",
    async () => {
      const country = pendingCountry ?? panic("No pending public country");
      const response = await buildApp().handle(
        new Request(
          `http://localhost/law/statutes/search?country=${country}&query=synthetic`,
        ),
      );

      expect(response.status).toBe(PUBLIC_COUNTRY_UNAVAILABLE_STATUS);
      expect(await response.json()).toEqual(publicCountryUnavailable(country));
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

/** A public law route whose request names one country at its top level. */
const namesPublicLawCountry = (route: {
  path: string;
  handler: unknown;
  hooks: SchemaNode;
}): boolean =>
  isSafePublicHandler(route.handler) &&
  PUBLIC_LAW_PATH_PREFIXES.some((prefix) => route.path.startsWith(prefix)) &&
  [route.hooks["query"], route.hooks["body"]].some((schema) => {
    const properties = isSchemaNode(schema) ? schema["properties"] : undefined;
    return (
      isSchemaNode(properties) &&
      COUNTRY_PARAMETERS.some((parameter) => parameter in properties)
    );
  });

describe("declared public country unavailability", () => {
  test("every mounted route declares the refusal only under its status, and every country-addressed public law route declares it", async () => {
    const { default: api } = await import("@/api/server");
    await api.modules;
    const routes = api.routes.map((route) => {
      const hooks: unknown = route.hooks;
      return {
        name: `${route.method} ${route.path}`,
        path: route.path,
        handler: route.handler,
        hooks: isSchemaNode(hooks) ? hooks : {},
      };
    });

    const declarations = routes.flatMap(({ name, hooks }) => {
      const response = hooks["response"];
      return isSchemaNode(response)
        ? Object.entries(response)
            .filter(([, schema]) => declaresRefusal(schema))
            .map(([status]) => ({ name, status }))
        : [];
    });
    expect(declarations.length).toBeGreaterThan(0);
    expect(
      declarations.filter(
        ({ status }) => status !== String(PUBLIC_COUNTRY_UNAVAILABLE_STATUS),
      ),
    ).toEqual([]);

    const countryRoutes = routes.filter(namesPublicLawCountry);
    expect(countryRoutes.length).toBeGreaterThan(0);
    const declaring = new Set(declarations.map(({ name }) => name));
    expect(
      countryRoutes
        .map(({ name }) => name)
        .filter((name) => !declaring.has(name)),
    ).toEqual([]);
  });
});
