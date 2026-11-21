/**
 * Path segments and query values reach a route as strings (a repeated query
 * key as a list of them), and the HTTP layer never coerces one. A `query` or
 * `params` schema whose field expects a number, a boolean or an object
 * therefore refuses every real request: the value has to be read from its
 * string by the schema itself (`numberFromString`, `booleanFromString`,
 * `arrayFromQuery`, `jsonFromString` in `@stll/api-contract/http-input`).
 *
 * `RouteConfig` refuses such a schema at compile time; this census reads the
 * composed route table at run time, so a schema that reached a route through a
 * wider type is caught too. It walks each schema and allows only the shapes
 * that read strings, so an unknown shape fails closed.
 */
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  arrayFromQuery,
  booleanFromString,
  jsonFromString,
  numberFromString,
} from "@stll/api-contract/http-input";
import type { HttpStringInput } from "@stll/api-contract/http-input";

import { apiRoutes } from "@/api/api-routes";
import type { RouteEntry } from "@/api/http/route";
import { paginationCursorSchema } from "@/api/lib/custom-schema";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Schemas that wrap another and read whatever it reads (plus absence). */
const WRAPPER_TYPES = new Set([
  "optional",
  "exact_optional",
  "nullish",
  "nullable",
  "undefinedable",
  "non_nullable",
  "non_nullish",
  "non_optional",
]);

/** Wrappers whose key may be absent from the request. */
const ABSENT_TYPES = new Set([
  "optional",
  "exact_optional",
  "nullish",
  "undefinedable",
]);

const OBJECT_TYPES = new Set([
  "object",
  "loose_object",
  "strict_object",
  "object_with_rest",
]);

const optionsOf = (schema: Record<string, unknown>): unknown[] => {
  const options = schema["options"];
  return Array.isArray(options) ? options : [];
};

/**
 * Where a field schema would refuse a string. A piped schema carries the type
 * of its first schema, which is what reads the raw value, so the pipe's later
 * steps (a transform to a number) never matter here.
 */
const fieldProblems = (schema: unknown, at: string): string[] => {
  if (!isRecord(schema) || typeof schema["type"] !== "string") {
    return [`${at}: not a schema`];
  }
  const type = schema["type"];
  if (WRAPPER_TYPES.has(type)) {
    return fieldProblems(schema["wrapped"], at);
  }
  switch (type) {
    case "string":
    case "unknown":
    case "any":
      return [];
    case "literal":
      return typeof schema["literal"] === "string"
        ? []
        : [`${at}: literal ${String(schema["literal"])}`];
    case "picklist":
    case "enum": {
      const options = optionsOf(schema);
      return options.length > 0 &&
        options.every((option) => typeof option === "string")
        ? []
        : [`${at}: ${type} of non-string options`];
    }
    case "union":
    case "variant": {
      const options = optionsOf(schema);
      return options.length === 0
        ? [`${at}: empty ${type}`]
        : options.flatMap((option) => fieldProblems(option, at));
    }
    case "array":
      // A repeated query key arrives as a list of strings.
      return fieldProblems(schema["item"], `${at}[]`);
    default:
      return [`${at}: ${type}`];
  }
};

/** Where a whole `query` or `params` schema would refuse a record of strings. */
const recordProblems = (schema: unknown, at: string): string[] => {
  if (!isRecord(schema) || typeof schema["type"] !== "string") {
    return [`${at}: not a schema`];
  }
  const type = schema["type"];
  if (WRAPPER_TYPES.has(type)) {
    return recordProblems(schema["wrapped"], at);
  }
  if (OBJECT_TYPES.has(type)) {
    const entries = schema["entries"];
    if (!isRecord(entries)) {
      return [`${at}: object without entries`];
    }
    return [
      ...Object.entries(entries).flatMap(([key, field]) =>
        fieldProblems(field, `${at}.${key}`),
      ),
      ...(type === "object_with_rest"
        ? fieldProblems(schema["rest"], `${at}.*`)
        : []),
    ];
  }
  if (type === "record") {
    return fieldProblems(schema["value"], `${at}.*`);
  }
  if (type === "union" || type === "variant" || type === "intersect") {
    const options = optionsOf(schema);
    return options.length === 0
      ? [`${at}: empty ${type}`]
      : options.flatMap((option) => recordProblems(option, at));
  }
  return [`${at}: ${type}`];
};

const pathSegments = (path: string): Set<string> =>
  new Set([...path.matchAll(/:(\w+)/gu)].flatMap((match) => match.slice(1)));

/** Required params keys the path never supplies, so no request can satisfy. */
const unsuppliedParams = (schema: unknown, path: string): string[] => {
  if (!isRecord(schema) || typeof schema["type"] !== "string") {
    return [];
  }
  if (!OBJECT_TYPES.has(schema["type"])) {
    return [];
  }
  const entries = schema["entries"];
  if (!isRecord(entries)) {
    return [];
  }
  const segments = pathSegments(path);
  return Object.entries(entries)
    .filter(
      ([key, field]) =>
        !segments.has(key) &&
        !(
          isRecord(field) &&
          typeof field["type"] === "string" &&
          ABSENT_TYPES.has(field["type"])
        ),
    )
    .map(([key]) => `params.${key}: not a segment of the path`);
};

const routeProblems = ({
  method,
  path,
  definition: { config },
}: RouteEntry): string[] => {
  const problems = [
    ...(config.query === undefined
      ? []
      : recordProblems(config.query, "query")),
    ...(config.params === undefined
      ? []
      : [
          ...recordProblems(config.params, "params"),
          ...unsuppliedParams(config.params, path),
        ]),
  ];
  return problems.map((problem) => `${method} ${path} ${problem}`);
};

const wireOffenders = (entries: readonly RouteEntry[]): string[] =>
  entries.flatMap(routeProblems);

const run = async () => "ok";

describe("wire input schemas", () => {
  test("the route table declares query and params schemas to read", () => {
    expect(
      apiRoutes.filter(
        ({ definition }) => definition.config.query !== undefined,
      ).length,
    ).toBeGreaterThan(50);
    expect(
      apiRoutes.filter(
        ({ definition }) => definition.config.params !== undefined,
      ).length,
    ).toBeGreaterThan(50);
  });

  test("every mounted query and params schema reads strings", () => {
    expect(wireOffenders(apiRoutes)).toEqual([]);
  });

  test("the wire helpers read strings and decode what they carry", () => {
    const query = v.object({
      limit: v.optional(numberFromString(v.pipe(v.number(), v.integer()))),
      archived: v.optional(booleanFromString()),
      tag: v.optional(arrayFromQuery(v.picklist(["a", "b"]))),
      filter: v.optional(jsonFromString(v.object({ id: v.string() }))),
      sort: v.optional(v.picklist(["asc", "desc"])),
    });
    expect(recordProblems(query, "query")).toEqual([]);
    expect(
      v.parse(query, {
        limit: "20",
        archived: "true",
        tag: ["a", "b"],
        filter: '{"id":"x"}',
        sort: "asc",
      }),
    ).toEqual({
      limit: 20,
      archived: true,
      tag: ["a", "b"],
      filter: { id: "x" },
      sort: "asc",
    });
  });

  test("the census reports each schema that cannot read a string", () => {
    expect(
      recordProblems(
        v.object({
          limit: v.optional(v.number()),
          archived: v.boolean(),
          filter: v.object({ id: v.string() }),
          tags: v.array(v.number()),
          mode: v.union([v.literal("a"), v.literal(1)]),
          size: v.picklist([1, 2]),
          ok: v.pipe(v.string(), v.transform(Number), v.number()),
        }),
        "query",
      ),
    ).toEqual([
      "query.limit: number",
      "query.archived: boolean",
      "query.filter: object",
      "query.tags[]: number",
      "query.mode: literal 1",
      "query.size: picklist of non-string options",
    ]);
    expect(recordProblems(v.number(), "query")).toEqual(["query: number"]);
    expect(
      recordProblems(
        v.lazy(() => v.object({})),
        "query",
      ),
    ).toEqual(["query: lazy"]);
  });

  test("the census reports a required param the path never supplies", () => {
    const params = v.object({
      fileId: v.string(),
      versionId: v.string(),
      revision: v.optional(v.string()),
    });
    expect(unsuppliedParams(params, "/v1/files/:fileId")).toEqual([
      "params.versionId: not a segment of the path",
    ]);
    expect(
      unsuppliedParams(params, "/v1/files/:fileId/versions/:versionId"),
    ).toEqual([]);
  });

  test("a mounted route with a non-wire query is reported", () => {
    const route: RouteEntry = {
      method: "GET",
      path: "/v1/items/:itemId",
      middleware: [],
      definition: {
        access: "public",
        config: {
          query: v.object({ cursor: v.optional(paginationCursorSchema()) }),
          params: v.object({ itemId: v.string() }),
        },
        run,
      },
    };
    expect(wireOffenders([route])).toEqual([]);
    // A schema whose declared input is a record of strings satisfies the
    // compile-time check whatever it does at run time; the census only admits
    // shapes it can show read strings.
    const opaque = v.custom<HttpStringInput>(
      (value) => isRecord(value) && typeof value["limit"] === "number",
    );
    expect(
      wireOffenders([
        {
          ...route,
          definition: {
            ...route.definition,
            config: { ...route.definition.config, query: opaque },
          },
        },
      ]),
    ).toEqual(["GET /v1/items/:itemId query: custom"]);
  });
});
