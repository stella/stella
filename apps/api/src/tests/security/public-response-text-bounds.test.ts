import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { isSafePublicHandler } from "@/api/lib/api-handlers";

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
  if (!isSchemaNode(schema)) {
    return [];
  }
  const fields: string[] = [];
  if (typeof schema["$ref"] === "string") {
    fields.push(`${path} unresolved-reference`);
  }
  const admitsString =
    schema["type"] === "string" ||
    (Array.isArray(schema["type"]) && schema["type"].includes("string"));
  if (admitsString && !hasStringBound(schema)) {
    fields.push(path);
  }
  if (isSchemaNode(schema["properties"])) {
    for (const [name, property] of Object.entries(schema["properties"])) {
      fields.push(...unboundedStringFields(property, `${path}.${name}`));
    }
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
  if (isSchemaNode(schema["additionalProperties"])) {
    fields.push(
      ...unboundedStringFields(schema["additionalProperties"], `${path}.*`),
    );
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
    if (
      "type" in response ||
      "anyOf" in response ||
      "oneOf" in response ||
      "allOf" in response ||
      "$ref" in response
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

describe("anonymous response text bounds", () => {
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
    expect(
      Object.keys(allowlist).filter((field) => !(field in existing)),
    ).toEqual([]);
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
