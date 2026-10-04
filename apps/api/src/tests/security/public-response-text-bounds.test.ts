import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { t } from "elysia";
import nodePath from "node:path";

import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
  isSafePublicHandler,
} from "@/api/lib/api-handlers";

import allowlist from "./public-response-text-bounds.allowlist.json";

type SchemaNode = Record<string, unknown>;

const isSchemaNode = (value: unknown): value is SchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasStringBound = (schema: SchemaNode): boolean =>
  (typeof schema["maxLength"] === "number" &&
    Number.isFinite(schema["maxLength"]) &&
    schema["maxLength"] >= 0) ||
  typeof schema["const"] === "string" ||
  (Array.isArray(schema["enum"]) &&
    schema["enum"].every((value: unknown) => typeof value === "string"));

// JSON Schema maxLength counts Unicode code points, so any finite maxLength
// implies a finite UTF-8 byte bound (at most four bytes per code point).
const unboundedStringFields = (schema: unknown, path: string): string[] => {
  if (schema === false) {
    return [];
  }
  if (!isSchemaNode(schema)) {
    return [path];
  }
  if (isSchemaNode(schema["not"]) && Object.keys(schema["not"]).length === 0) {
    return [];
  }
  const fields: string[] = [];
  if (typeof schema["$ref"] === "string") {
    return [`${path} unresolved-reference`];
  }
  const types = Array.isArray(schema["type"])
    ? schema["type"]
    : [schema["type"]];
  const knownTypes = [
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    "object",
    "array",
  ];
  const hasKnownType =
    types.length > 0 && types.every((type) => knownTypes.includes(type));
  const hasBranches = ["anyOf", "oneOf", "allOf"].some(
    (keyword) => Array.isArray(schema[keyword]) && schema[keyword].length > 0,
  );
  // An absent or unfamiliar type is not evidence that strings are excluded.
  // Composition schemas are inspected branch by branch, including Any/Unknown.
  if (
    (!hasKnownType && "type" in schema) ||
    (!hasKnownType &&
      !hasBranches &&
      !("const" in schema) &&
      !Array.isArray(schema["enum"]))
  ) {
    fields.push(path);
  }
  const admitsString =
    schema["type"] === "string" ||
    (Array.isArray(schema["type"]) && schema["type"].includes("string"));
  if (admitsString && !hasStringBound(schema)) {
    fields.push(path);
  }
  if (
    types.includes("object") &&
    !hasBranches &&
    !isSchemaNode(schema["properties"]) &&
    !isSchemaNode(schema["patternProperties"]) &&
    schema["additionalProperties"] === undefined
  ) {
    fields.push(`${path}.*`);
  }
  if (isSchemaNode(schema["properties"])) {
    for (const [name, property] of Object.entries(schema["properties"])) {
      fields.push(...unboundedStringFields(property, `${path}.${name}`));
    }
  }
  if (types.includes("array") && schema["items"] === undefined) {
    fields.push(`${path}[]`);
  }
  if (schema["items"] !== undefined) {
    if (Array.isArray(schema["items"])) {
      for (const [index, item] of schema["items"].entries()) {
        fields.push(...unboundedStringFields(item, `${path}[${index}]`));
      }
    } else {
      fields.push(...unboundedStringFields(schema["items"], `${path}[]`));
    }
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      fields.push(...unboundedStringFields(branch, path));
    }
  }
  // Elysia cleans undeclared response properties by default; an explicit
  // additional-properties schema opts values into the serialized response.
  for (const keyword of ["additionalProperties", "unevaluatedProperties"]) {
    if (schema[keyword] !== undefined) {
      fields.push(...unboundedStringFields(schema[keyword], `${path}.*`));
    }
  }
  if (isSchemaNode(schema["patternProperties"])) {
    for (const property of Object.values(schema["patternProperties"])) {
      fields.push(...unboundedStringFields(property, `${path}.*`));
    }
  }
  return fields;
};

type PublicRoute = {
  method: string;
  path: string;
  handler: unknown;
  hooks: { response?: unknown };
};

const publicRouteUnboundedFields = (
  routes: readonly PublicRoute[],
): string[] => {
  const fields: string[] = [];
  for (const route of routes) {
    if (!isSafePublicHandler(route.handler)) {
      continue;
    }
    const prefix = `${route.method} ${route.path}`;
    const response = route.hooks.response;
    if (!isSchemaNode(response)) {
      fields.push(`${prefix} response-schema`);
      continue;
    }
    const statuses = Object.keys(response);
    // TypeBox Any and Unknown have no enumerable type keyword. Only a
    // nonempty HTTP-status map can be interpreted as response alternatives.
    if (
      statuses.length === 0 ||
      !statuses.every((status) => /^[1-5]\d{2}$/u.test(status))
    ) {
      fields.push(...unboundedStringFields(response, `${prefix} response`));
      continue;
    }
    for (const [status, schema] of Object.entries(response)) {
      fields.push(...unboundedStringFields(schema, `${prefix} ${status}`));
    }
  }
  return [...new Set(fields)].toSorted();
};

const WHOLE_DOCUMENT_TEXT_REASON =
  "Whole official document text by design; bounded per source at ingestion, not at the response; a windowed reader contract is a separate change.";

// Only the complete text on existing reader routes can refine a coarse exception.
const isWholeReaderRefinement = ({
  field,
  reason,
  prior,
  current,
}: {
  field: string;
  reason: string;
  prior: SchemaNode;
  current: SchemaNode;
}): boolean => {
  const match =
    /^(GET \/v1\/(law\/statutes|case\/decisions)\/(?:by-eli|by-slug\/:slug|:documentId|:decisionId)) 200\.(?:fulltext|documentAst|sections\[\]\.text)$/u.exec(
      field,
    );
  const route = match?.at(1);
  const family = match?.at(2);
  if (route === undefined || family === undefined) {
    return false;
  }
  const coarse = `${route} response-schema`;
  return (
    reason === WHOLE_DOCUMENT_TEXT_REASON &&
    coarse in prior &&
    !(coarse in current)
  );
};

const forbiddenLedgerAdditions = (
  prior: SchemaNode,
  current: Record<string, string>,
) =>
  Object.entries(current)
    .filter(
      ([field, reason]) =>
        !(field in prior) &&
        !isWholeReaderRefinement({ field, reason, prior, current }),
    )
    .map(([field]) => field);

describe("anonymous response text bounds", () => {
  test("reader refinements replace an existing same-route coarse exception", () => {
    const field = "GET /v1/law/statutes/:documentId 200.fulltext";
    const coarse = "GET /v1/law/statutes/:documentId response-schema";
    const reason = WHOLE_DOCUMENT_TEXT_REASON;
    const refinement = {
      field,
      reason,
      prior: { [coarse]: "existing" },
      current: { [field]: reason },
    };
    expect(isWholeReaderRefinement(refinement)).toBe(true);
    // A newly added route cannot inherit another route's exception.
    expect(
      isWholeReaderRefinement({
        ...refinement,
        field: "GET /v1/law/statutes/by-eli 200.fulltext",
      }),
    ).toBe(false);
    expect(isWholeReaderRefinement({ ...refinement, prior: {} })).toBe(false);
    expect(
      isWholeReaderRefinement({
        ...refinement,
        current: { [coarse]: "existing", [field]: reason },
      }),
    ).toBe(false);
  });

  test("reader refinements require whole-document fields and their exact reason", () => {
    const coarse = "GET /v1/law/statutes/:documentId response-schema";
    const reason = WHOLE_DOCUMENT_TEXT_REASON;
    const refinement = {
      field: "GET /v1/law/statutes/:documentId 200.documentAst",
      reason,
      prior: { [coarse]: "existing" },
      current: {},
    };
    expect(isWholeReaderRefinement(refinement)).toBe(true);
    for (const field of [
      "title",
      "sourceUrl",
      "sections[].title",
      "documentAst.*",
      "preview",
    ]) {
      expect(
        isWholeReaderRefinement({
          ...refinement,
          field: `GET /v1/law/statutes/:documentId 200.${field}`,
        }),
      ).toBe(false);
    }
    expect(isWholeReaderRefinement({ ...refinement, reason: "" })).toBe(false);
    expect(
      isWholeReaderRefinement({ ...refinement, reason: "whole text" }),
    ).toBe(false);
    expect(
      isWholeReaderRefinement({
        ...refinement,
        field: "GET /v1/law/statutes/:documentId 503.fulltext",
      }),
    ).toBe(false);
    expect(
      isWholeReaderRefinement({
        ...refinement,
        field: "GET /v1/law/statutes/search 200.fulltext",
        prior: { "GET /v1/law/statutes/search response-schema": "existing" },
      }),
    ).toBe(false);
  });

  test("case-law refinements use the same exact whole-document reason", () => {
    const route = "GET /v1/case/decisions/:decisionId";
    const reason = WHOLE_DOCUMENT_TEXT_REASON;
    for (const path of ["fulltext", "documentAst", "sections[].text"]) {
      expect(
        isWholeReaderRefinement({
          field: `${route} 200.${path}`,
          reason,
          prior: { [`${route} response-schema`]: "existing" },
          current: {},
        }),
      ).toBe(true);
    }
    expect(
      isWholeReaderRefinement({
        field: `${route} 200.fulltext`,
        reason: "Whole official decision text by design",
        prior: { [`${route} response-schema`]: "existing" },
        current: {},
      }),
    ).toBe(false);
  });

  test("ordinary ledger entries remain strictly shrink-only", () => {
    const existing = "GET /existing 200.message";
    const prior = { [existing]: "existing bound gap" };
    expect(forbiddenLedgerAdditions(prior, {})).toEqual([]);
    expect(forbiddenLedgerAdditions(prior, prior)).toEqual([]);
    const added = "GET /new response-schema";
    expect(
      forbiddenLedgerAdditions(prior, { ...prior, [added]: "new" }),
    ).toEqual([added]);
    const metadata = "GET /existing 200.title";
    expect(forbiddenLedgerAdditions(prior, { [metadata]: "new" })).toEqual([
      metadata,
    ]);
  });

  test("every mounted public response string has a finite byte bound or an existing exception", async () => {
    const { default: api } = await import("@/api/server");
    await api.modules;
    const routes = api.routes.filter((route) =>
      isSafePublicHandler(route.handler),
    );
    expect(routes.length).toBeGreaterThan(0);
    const fields = publicRouteUnboundedFields(routes);
    const exceptions = Object.keys(allowlist).toSorted();
    // Equality also removes stale exemptions as soon as their schema is bounded.
    expect(fields).toEqual(exceptions);
    for (const reason of Object.values(allowlist)) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  test("the exception ledger only shrinks from the merge base", () => {
    const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
    const ledger =
      "apps/api/src/tests/security/public-response-text-bounds.allowlist.json";
    const base = Bun.spawnSync(["git", "merge-base", "HEAD", "origin/main"], {
      cwd: repoRoot,
    });
    expect(base.exitCode).toBe(0);
    const revision = new TextDecoder().decode(base.stdout).trim();
    const present = Bun.spawnSync(
      ["git", "ls-tree", "--name-only", revision, ledger],
      { cwd: repoRoot },
    );
    expect(present.exitCode).toBe(0);
    // The introducing change establishes the ledger; subsequent changes must
    // remove entries, and cannot replace a removed entry with another field.
    if (new TextDecoder().decode(present.stdout).trim() === "") {
      return;
    }
    const prior = Bun.spawnSync(["git", "show", `${revision}:${ledger}`], {
      cwd: repoRoot,
    });
    expect(prior.exitCode).toBe(0);
    const existing: unknown = JSON.parse(
      new TextDecoder().decode(prior.stdout),
    );
    expect(isSchemaNode(existing)).toBe(true);
    if (!isSchemaNode(existing)) {
      return;
    }
    expect(forbiddenLedgerAdditions(existing, allowlist)).toEqual([]);
  });

  test.each([
    ["Any", t.Any()],
    ["Unknown", t.Unknown()],
    ["an integer wire-schema string branch", t.Integer()],
    ["a union containing Any", t.Union([t.Number(), t.Any()])],
    ["a union containing Unknown", t.Union([t.Number(), t.Unknown()])],
    ["an intersection containing Any", t.Intersect([t.Number(), t.Any()])],
    [
      "an intersection containing Unknown",
      t.Intersect([t.Number(), t.Unknown()]),
    ],
    ["an empty schema", {}],
    ["an unfamiliar type", { type: "unreviewed" }],
    [
      "an unfamiliar type mixed with number",
      { type: ["number", "unreviewed"] },
    ],
    [
      "an unfamiliar type mixed with bounded string",
      { type: ["string", "unreviewed"], maxLength: 12 },
    ],
    ["an unfamiliar keyword", { unreviewed: true }],
    ["a true schema", true],
    ["a malformed schema", null],
  ])("the guard treats %s as unbounded", (_name, schema) => {
    expect(unboundedStringFields(schema, "fixture")).toContain("fixture");
  });

  test("known string-free and finite scalar schemas remain bounded", () => {
    for (const schema of [
      t.Number(),
      { type: "integer" },
      t.Boolean(),
      t.Null(),
      t.Never(),
      t.Literal("ready"),
      t.Literal(1),
      t.Union([t.Number(), t.Null()]),
      t.String({ maxLength: 12 }),
      false,
    ]) {
      expect(unboundedStringFields(schema, "fixture")).toEqual([]);
    }
  });

  test("unknown nested values and open containers remain unbounded", () => {
    expect(
      unboundedStringFields(
        t.Object({
          any: t.Any(),
          unknown: t.Unknown(),
          nested: t.Array(t.Unknown()),
          values: t.Record(t.String(), t.Any()),
        }),
        "fixture",
      ),
    ).toEqual([
      "fixture.any",
      "fixture.unknown",
      "fixture.nested[]",
      "fixture.values.*",
    ]);
    expect(unboundedStringFields({ type: "object" }, "fixture")).toEqual([
      "fixture.*",
    ]);
    expect(unboundedStringFields(t.Object({}), "fixture")).toEqual([]);
    expect(
      unboundedStringFields(
        {
          allOf: [t.Object({})],
          unevaluatedProperties: t.Unknown(),
        },
        "fixture",
      ),
    ).toEqual(["fixture.*"]);
    expect(unboundedStringFields({ type: "array" }, "fixture")).toEqual([
      "fixture[]",
    ]);
    for (const additionalProperties of [
      true,
      "unreviewed",
      {},
      t.Any(),
      t.Unknown(),
    ]) {
      expect(
        unboundedStringFields(
          {
            type: "object",
            additionalProperties,
          },
          "fixture",
        ),
      ).toEqual(["fixture.*"]);
    }
    expect(
      unboundedStringFields(
        {
          type: "object",
          additionalProperties: false,
        },
        "fixture",
      ),
    ).toEqual([]);
    expect(
      unboundedStringFields({ type: "array", items: false }, "fixture"),
    ).toEqual([]);
    expect(
      unboundedStringFields(
        { type: "array", items: { type: "unreviewed" } },
        "fixture",
      ),
    ).toEqual(["fixture[]"]);
  });

  test("top-level unconstrained schemas are not mistaken for empty status maps", () => {
    const { handler } = createSafePublicHandler(
      {
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "health_infra" },
        cache: { kind: "none" },
      },
      async function* () {
        return Result.ok({});
      },
    );
    for (const response of [
      t.Any(),
      t.Unknown(),
      {},
      { futureKeyword: true },
    ]) {
      expect(
        publicRouteUnboundedFields([
          {
            method: "GET",
            path: "/fixture",
            handler,
            hooks: { response },
          },
        ]),
      ).toEqual(["GET /fixture response"]);
    }
    expect(
      publicRouteUnboundedFields([
        {
          method: "GET",
          path: "/fixture",
          handler,
          hooks: { response: true },
        },
      ]),
    ).toEqual(["GET /fixture response-schema"]);
    expect(
      publicRouteUnboundedFields([
        {
          method: "GET",
          path: "/fixture",
          handler,
          hooks: { response: { 200: t.Any(), 400: t.Unknown() } },
        },
      ]),
    ).toEqual(["GET /fixture 200", "GET /fixture 400"]);
  });

  test("the guard rejects a newly unbounded fixture field", () => {
    const schema = {
      type: "object",
      properties: {
        bounded: { type: "string", maxLength: 12 },
        fixed: { type: "string", const: "ready" },
        unbounded: { type: "string" },
        nested: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        reference: { $ref: "UnreviewedModel" },
        nullable: { type: ["string", "null"] },
        tuple: { type: "array", items: [{ type: "string" }] },
      },
    };
    expect(unboundedStringFields(schema, "fixture")).toEqual([
      "fixture.unbounded",
      "fixture.nested[]",
      "fixture.reference unresolved-reference",
      "fixture.nullable",
      "fixture.tuple[0]",
    ]);
  });
});
