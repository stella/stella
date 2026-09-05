import { Kind, OptionalKind } from "@sinclair/typebox";
import type { TObject, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { multipartFormParser } from "@/api/lib/multipart-form-parser";

import { discoverSafeHandlers } from "../../../scripts/lib/enumerate-safe-handlers";

// Elysia's built-in multipart parser runs before route validation and turns
// any form field whose value starts with `{` or `[` into a parsed object. A
// body schema that types such a field as `t.String()` therefore rejects a
// perfectly typed request with a 422, and neither TypeBox's static type nor
// the Eden client can see it: both say `string`. `multipartFormParser` takes
// that parser's place on the API app; this census mounts the real body schema
// of every handler that accepts a multipart body behind the same plugin and
// posts a JSON-shaped value into every free-text string field, so a handler
// that would regress fails here instead of in the browser.

/** Endpoint ids are repo-relative; trim the tree prefix so an offender reads
 *  as `templates/fill.ts`. */
const HANDLERS_PREFIX = "apps/api/src/handlers/";
const JSON_SHAPED_VALUE = '{"probe":true}';
const PLAIN_VALUE = "probe";

/** Floor on the number of multipart handlers the census must discover, a
 *  small margin under the current count. It fails loudly if discovery breaks
 *  and stops finding the handlers it is supposed to be probing. */
const MIN_MULTIPART_HANDLERS = 16;

const isObjectSchema = (schema: unknown): schema is TObject =>
  typeof schema === "object" &&
  schema !== null &&
  Kind in schema &&
  schema[Kind] === "Object";

/** The schema's TypeBox kind, or `""` for a value carrying no kind symbol. */
const kindOf = (schema: TSchema): string => {
  const kind: unknown = schema[Kind];
  return typeof kind === "string" ? kind : "";
};

const isFileSchema = (schema: TSchema): boolean => {
  const kind = kindOf(schema);
  return kind === "File" || kind === "Files";
};

/** TypeBox schemas carry their keywords as plain properties (`TSchema` has a
 *  string index signature), so read them without asserting a shape. */
const stringKeyword = (schema: TSchema, key: string): string | undefined => {
  const value: unknown = schema[key];
  return typeof value === "string" ? value : undefined;
};

const numberKeyword = (schema: TSchema, key: string): number | undefined => {
  const value: unknown = schema[key];
  return typeof value === "number" ? value : undefined;
};

const unionMembers = (schema: TSchema): TSchema[] => {
  const anyOf: unknown = schema["anyOf"];
  return Array.isArray(anyOf) ? anyOf : [];
};

const stringMember = (schema: TSchema): TSchema | undefined => {
  const kind = kindOf(schema);
  if (kind === "String") {
    return schema;
  }
  if (kind !== "Union") {
    return undefined;
  }
  return unionMembers(schema).find((member) => kindOf(member) === "String");
};

/**
 * A string field that may legitimately carry free text. Identifier-shaped
 * strings (a format, a pattern, or a length window that excludes both probe
 * values) can never hold JSON-looking text, so the parser cannot change
 * their outcome; they are filled, not probed.
 */
const isFreeTextField = (schema: TSchema): boolean => {
  const member = stringMember(schema);
  if (!member) {
    return false;
  }
  return (
    stringKeyword(member, "format") === undefined &&
    stringKeyword(member, "pattern") === undefined &&
    (numberKeyword(member, "minLength") ?? 0) <= PLAIN_VALUE.length &&
    (numberKeyword(member, "maxLength") ?? Number.POSITIVE_INFINITY) >=
      JSON_SHAPED_VALUE.length
  );
};

const isOptional = (schema: TSchema): boolean => OptionalKind in schema;

/**
 * Candidates for a required string-shaped field, offered in order. The field's
 * own schema decides which one it accepts, so a patterned id, a hash, or a
 * plain string all get filled without this test restating their rules. The
 * hash is computed, not pasted, so it is a real digest rather than a literal
 * that could drift out of the shape a `sha256` field demands.
 */
const STRING_FILLERS = [
  PLAIN_VALUE,
  "00000000-0000-4000-8000-000000000000",
  new Bun.CryptoHasher("sha256").update(PLAIN_VALUE).digest("hex"),
];

/**
 * A representative value for a required non-file field so the probe request is
 * valid apart from the JSON-shaped strings under test. Kinds Elysia coerces
 * from the wire (numbers, booleans, literals) get their coercible text; every
 * string-shaped kind is filled by asking the schema itself.
 */
const filler = (schema: TSchema): string | null => {
  switch (kindOf(schema)) {
    case "Literal":
      return String(schema["const"]);
    case "Boolean":
      return "true";
    case "Number":
    case "Integer":
      return "1";
    case "Union": {
      for (const member of unionMembers(schema)) {
        const value = filler(member);
        if (value !== null) {
          return value;
        }
      }
      return null;
    }
    default: {
      // Closed value sets (`t.UnionEnum`) carry their members as `enum`.
      const members: unknown = schema["enum"];
      if (Array.isArray(members) && members.length > 0) {
        return String(members[0]);
      }
      return (
        STRING_FILLERS.find((candidate) => Value.Check(schema, candidate)) ??
        null
      );
    }
  }
};

type MultipartHandler = {
  file: string;
  body: TObject;
  stringFields: string[];
};

type MultipartCensus = {
  handlers: MultipartHandler[];
  importErrors: { id: string; message: string }[];
};

/**
 * Keeps the endpoints whose declared body carries a file field. Discovery is
 * `discoverSafeHandlers()`, the same enumerator the MCP coverage guard and the
 * capability-catalog exporter use, so the census and those guards can never
 * disagree about what the handler universe is. It also imports only modules
 * that call a safe-handler factory, which is what keeps a standalone CLI
 * script in the handler tree from running its side effects here.
 */
const loadMultipartHandlers = async (): Promise<MultipartCensus> => {
  const { endpoints, importErrors } = await discoverSafeHandlers();
  const handlers: MultipartHandler[] = [];

  for (const { id, config } of endpoints) {
    const body = config["body"];
    if (!isObjectSchema(body)) {
      continue;
    }
    const properties = Object.entries(body.properties);
    if (!properties.some(([, schema]) => isFileSchema(schema))) {
      continue;
    }
    handlers.push({
      file: id.startsWith(HANDLERS_PREFIX)
        ? id.slice(HANDLERS_PREFIX.length)
        : id,
      body,
      stringFields: properties
        .filter(([, schema]) => isFreeTextField(schema))
        .map(([name]) => name),
    });
  }

  return { handlers, importErrors };
};

const buildForm = (body: TObject, stringValue: string): FormData => {
  const form = new FormData();
  for (const [name, schema] of Object.entries(body.properties)) {
    if (isFileSchema(schema)) {
      form.append(
        name,
        new File(["probe"], "probe.bin", { type: "application/octet-stream" }),
      );
      continue;
    }
    if (isFreeTextField(schema)) {
      form.append(name, stringValue);
      continue;
    }
    if (isOptional(schema)) {
      continue;
    }
    const value = filler(schema);
    if (value !== null) {
      form.append(name, value);
    }
  }
  return form;
};

type ProbeOutcome = { status: number; detail: string };

/**
 * Mounts the schema behind the same parser the API app installs, so the probe
 * exercises the production request pipeline rather than a bare Elysia app.
 */
const postForm = async (
  body: TObject,
  form: FormData,
): Promise<ProbeOutcome> => {
  const app = new Elysia()
    .use(multipartFormParser)
    .post("/probe", () => "ok", { body });
  const response = await app.handle(
    new Request("http://localhost/probe", { method: "POST", body: form }),
  );
  const detail = response.status === 200 ? "" : await response.text();
  return { status: response.status, detail: detail.slice(0, 300) };
};

describe("multipart body string fields", () => {
  test(
    "every multipart handler string field survives a JSON-shaped value",
    async () => {
      const { handlers, importErrors } = await loadMultipartHandlers();

      // An unimportable module is an unmeasured handler, so say so rather than
      // letting the census quietly cover less than it claims.
      expect(importErrors).toEqual([]);

      // The census only means something if it actually found the handlers.
      expect(handlers.length).toBeGreaterThanOrEqual(MIN_MULTIPART_HANDLERS);

      // A handler whose schema lives in a sibling module is exactly the case a
      // source-text scan misses, so pin one: `entities/upload-version.ts` names
      // no file field of its own, it imports `uploadVersionBodySchema`.
      expect(handlers.map(({ file }) => file)).toContain(
        "entities/upload-version.ts",
      );

      const offenders: string[] = [];
      for (const { file, body, stringFields } of handlers) {
        if (stringFields.length === 0) {
          continue;
        }
        // Baseline: the probe request itself must be valid with plain strings,
        // otherwise a failure below would say nothing about JSON parsing.
        const baseline = await postForm(body, buildForm(body, PLAIN_VALUE));
        expect(`${file}: baseline ${baseline.status} ${baseline.detail}`).toBe(
          `${file}: baseline 200 `,
        );

        const probe = await postForm(body, buildForm(body, JSON_SHAPED_VALUE));
        if (probe.status !== 200) {
          offenders.push(
            `${file} (${stringFields.join(", ")}) -> ${probe.status} ${probe.detail}`,
          );
        }
      }

      expect(offenders).toEqual([]);
    },
    { timeout: 30_000 },
  );
});
