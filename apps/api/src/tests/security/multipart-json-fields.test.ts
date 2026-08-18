import { Kind, OptionalKind } from "@sinclair/typebox";
import type { TObject, TSchema } from "@sinclair/typebox";
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { readdir } from "node:fs/promises";
import nodePath from "node:path";

import { multipartFormParser } from "@/api/lib/multipart-form-parser";

// Elysia's built-in multipart parser runs before route validation and turns
// any form field whose value starts with `{` or `[` into a parsed object. A
// body schema that types such a field as `t.String()` therefore rejects a
// perfectly typed request with a 422, and neither TypeBox's static type nor
// the Eden client can see it: both say `string`. `multipartFormParser` takes
// that parser's place on the API app; this census mounts the real body schema
// of every handler that accepts a multipart body behind the same plugin and
// posts a JSON-shaped value into every free-text string field, so a handler
// that would regress fails here instead of in the browser.

const HANDLERS_DIR = nodePath.join(import.meta.dir, "../../handlers");
const JSON_SHAPED_VALUE = '{"probe":true}';
const PLAIN_VALUE = "probe";

/** Floor on the number of multipart handlers the census must discover, a
 *  small margin under the current count. It fails loudly if discovery breaks
 *  and stops finding the handlers it is supposed to be probing. */
const MIN_MULTIPART_HANDLERS = 14;

const listTypeScriptFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      // oxlint-disable-next-line no-await-in-loop -- recursive depth-first traversal accumulates files in directory order
      files.push(...(await listTypeScriptFiles(path)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
};

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

const UUID_FILLER = "00000000-0000-4000-8000-000000000000";

/**
 * A representative value for a required non-string, non-file field so the
 * probe request is valid apart from the JSON-shaped strings under test.
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
    case "String":
      return stringKeyword(schema, "format") === "uuid" ||
        numberKeyword(schema, "minLength") === UUID_FILLER.length
        ? UUID_FILLER
        : PLAIN_VALUE;
    case "Union": {
      for (const member of unionMembers(schema)) {
        const value = filler(member);
        if (value !== null) {
          return value;
        }
      }
      return null;
    }
    default:
      return null;
  }
};

type MultipartHandler = {
  file: string;
  body: TObject;
  stringFields: string[];
};

type MultipartCensus = {
  handlers: MultipartHandler[];
  importFailures: string[];
};

/** The body schema a handler module declares, or `undefined` when the module
 *  is not a `{ config, handler }` endpoint. Read structurally: a handler can
 *  import its schema from a sibling module, so nothing about the schema is
 *  visible in the handler's own source text. */
const declaredBody = (module: unknown): unknown =>
  typeof module === "object" &&
  module !== null &&
  "default" in module &&
  typeof module.default === "object" &&
  module.default !== null &&
  "config" in module.default &&
  typeof module.default.config === "object" &&
  module.default.config !== null &&
  "body" in module.default.config
    ? module.default.config.body
    : undefined;

/**
 * Imports every handler module and keeps the ones whose body schema carries a
 * file field. A module that cannot be imported is reported, never skipped: a
 * silent skip would shrink the census without shrinking the risk.
 */
const loadMultipartHandlers = async (): Promise<MultipartCensus> => {
  const handlers: MultipartHandler[] = [];
  const importFailures: string[] = [];

  for (const file of await listTypeScriptFiles(HANDLERS_DIR)) {
    if (file.endsWith(".test.ts") || file.endsWith(".d.ts")) {
      continue;
    }
    const relative = nodePath.relative(HANDLERS_DIR, file);

    let module: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential loads keep the census deterministic
      module = await import(file);
    } catch (error) {
      importFailures.push(
        `${relative}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const body = declaredBody(module);
    if (!isObjectSchema(body)) {
      continue;
    }
    const properties = Object.entries(body.properties);
    if (!properties.some(([, schema]) => isFileSchema(schema))) {
      continue;
    }
    handlers.push({
      file: relative,
      body,
      stringFields: properties
        .filter(([, schema]) => isFreeTextField(schema))
        .map(([name]) => name),
    });
  }

  return { handlers, importFailures };
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
  test("every multipart handler string field survives a JSON-shaped value", async () => {
    const { handlers, importFailures } = await loadMultipartHandlers();

    // An unimportable module is an unmeasured handler, so say so rather than
    // letting the census quietly cover less than it claims.
    expect(importFailures).toEqual([]);

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
      // oxlint-disable-next-line no-await-in-loop -- sequential probes keep offender ordering deterministic
      const baseline = await postForm(body, buildForm(body, PLAIN_VALUE));
      expect(`${file}: baseline ${baseline.status} ${baseline.detail}`).toBe(
        `${file}: baseline 200 `,
      );

      // oxlint-disable-next-line no-await-in-loop -- sequential probes keep offender ordering deterministic
      const probe = await postForm(body, buildForm(body, JSON_SHAPED_VALUE));
      if (probe.status !== 200) {
        offenders.push(
          `${file} (${stringFields.join(", ")}) -> ${probe.status} ${probe.detail}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
