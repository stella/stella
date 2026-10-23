import { afterAll, describe, expect, test } from "bun:test";
import type * as v from "valibot";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import {
  isValibotSchema,
  toRouteJsonSchema,
} from "@/api/lib/json-schema/valibot-to-json-schema";
import type { JsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";

import { discoverSafeHandlers } from "../../../scripts/lib/enumerate-safe-handlers";

// A multipart form carries every field as text. A body reader that turned a
// field whose value starts with `{` or `[` into a parsed object would make a
// body schema that reads that field as a string reject a perfectly typed
// request with a 422, while the route's static type still says `string`. The
// HTTP core reads multipart flat (`http/input.ts`): values pass through as
// text and a field that carries a document says so in its schema
// (`jsonFromString`). This census mounts the real body schema of every handler
// that accepts a multipart body on the real `Bun.serve` core and posts a
// JSON-shaped value into every free-text string field, so a reader or schema
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

const probeFile = () =>
  new File(["probe"], "probe.bin", { type: "application/octet-stream" });

/** Whether a schema accepts a value, sync or async alike. */
const accepts = async (
  schema: v.GenericSchema,
  value: unknown,
): Promise<boolean> =>
  (await schema["~standard"].validate(value)).issues === undefined;

const OBJECT_TYPES = new Set(["object", "loose_object", "strict_object"]);
const FILE_TYPES = new Set(["file", "blob"]);

/** The entries of a valibot object schema, or `undefined` for another schema. */
const objectEntries = (
  schema: v.GenericSchema,
): [string, v.GenericSchema][] | undefined => {
  if (!OBJECT_TYPES.has(schema.type) || !("entries" in schema)) {
    return undefined;
  }
  const { entries } = schema;
  if (!isRecord(entries)) {
    return undefined;
  }
  return Object.entries(entries).flatMap(
    ([name, entry]): [string, v.GenericSchema][] =>
      isValibotSchema(entry) ? [[name, entry]] : [],
  );
};

/** A schema nested in a wrapper, a list or a union. */
const innerSchemas = (schema: v.GenericSchema): v.GenericSchema[] => {
  const inner: unknown[] = [];
  if ("wrapped" in schema) {
    inner.push(schema.wrapped);
  }
  if ("item" in schema) {
    inner.push(schema.item);
  }
  if ("options" in schema && isUnknownArray(schema.options)) {
    inner.push(...schema.options);
  }
  return inner.filter(isValibotSchema);
};

const declaresFile = (schema: v.GenericSchema): boolean =>
  FILE_TYPES.has(schema.type) ||
  (schema.type === "instance" &&
    "class" in schema &&
    (schema.class === File || schema.class === Blob)) ||
  innerSchemas(schema).some(declaresFile);

/**
 * A file field: one that declares a file, or that takes an uploaded file and
 * refuses text and a plain object in its place. The object probe matters: a
 * valibot record or object accepts any non-array object, an uploaded `File`
 * included, so without it a JSON body's `v.record(...)` field would make that
 * JSON handler look like a multipart one.
 */
const isFileSchema = async (schema: v.GenericSchema): Promise<boolean> =>
  declaresFile(schema) ||
  ((await accepts(schema, probeFile())) &&
    !(await accepts(schema, PLAIN_VALUE)) &&
    !(await accepts(schema, {})));

/** A rendered schema, or one of its members read back as plain data. */
type JsonNode = JsonSchema | Record<string, unknown>;

/** The string member of a field as clients see it, if it reads a string. */
const stringMember = (rendered: JsonNode): JsonNode | undefined => {
  const type = rendered["type"];
  if (type === "string" || (isUnknownArray(type) && type.includes("string"))) {
    return rendered;
  }
  const anyOf = rendered["anyOf"];
  return isUnknownArray(anyOf)
    ? anyOf.filter(isRecord).find((member) => member["type"] === "string")
    : undefined;
};

/**
 * A string field that may legitimately carry free text. Identifier-shaped
 * strings (a closed set of values, a format, a pattern, or a length window
 * that excludes both probe values) can never hold JSON-looking text, so the reader cannot change their
 * outcome; they are filled, not probed. A field that declares a JSON document
 * (`jsonFromString`) is shown as that document, not as a string, so it is
 * never probed either: parsing it is its job.
 */
const isFreeTextField = (schema: v.GenericSchema): boolean => {
  const member = stringMember(toRouteJsonSchema(schema));
  if (member === undefined) {
    return false;
  }
  const minLength = member["minLength"];
  const maxLength = member["maxLength"];
  return (
    // A closed set (`picklist`, `literal`) is filled with one of its values.
    closedValues(member).length === 0 &&
    member["format"] === undefined &&
    member["pattern"] === undefined &&
    (typeof minLength === "number" ? minLength : 0) <= PLAIN_VALUE.length &&
    (typeof maxLength === "number" ? maxLength : Number.POSITIVE_INFINITY) >=
      JSON_SHAPED_VALUE.length
  );
};

/** A field the request may leave out. */
const isOptional = async (schema: v.GenericSchema): Promise<boolean> =>
  await accepts(schema, undefined);

/**
 * Wire values offered for a required non-file field, in order. The field's
 * own schema decides which one it accepts, so a patterned id, a hash, a
 * wire-read number or boolean, or a plain string all get filled without this
 * test restating their rules. The hash is computed, not pasted, so it is a
 * real digest rather than a literal that could drift out of the shape a
 * `sha256` field demands.
 */
const STRING_FILLERS = [
  PLAIN_VALUE,
  "true",
  "1",
  "00000000-0000-4000-8000-000000000000",
  hashSha256Hex(PLAIN_VALUE),
];

/** The closed values a field shows clients (`const`, `enum`), as wire text. */
const closedValues = (rendered: JsonNode): string[] => {
  const values: unknown[] = [];
  if ("const" in rendered) {
    values.push(rendered["const"]);
  }
  const members = rendered["enum"];
  if (isUnknownArray(members)) {
    values.push(...members);
  }
  const anyOf = rendered["anyOf"];
  if (isUnknownArray(anyOf)) {
    values.push(...anyOf.filter(isRecord).flatMap(closedValues));
  }
  return values.map(String);
};

/**
 * A representative value for a required non-file field so the probe request
 * is valid apart from the JSON-shaped strings under test.
 */
const filler = async (schema: v.GenericSchema): Promise<string | null> => {
  for (const candidate of [
    ...closedValues(toRouteJsonSchema(schema)),
    ...STRING_FILLERS,
  ]) {
    if (await accepts(schema, candidate)) {
      return candidate;
    }
  }
  return null;
};

type BodyField = {
  name: string;
  schema: v.GenericSchema;
  file: boolean;
  freeText: boolean;
  optional: boolean;
};

type MultipartHandler = {
  file: string;
  body: v.GenericSchema;
  fields: BodyField[];
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
    if (!isValibotSchema(body)) {
      continue;
    }
    const entries = objectEntries(body);
    if (entries === undefined) {
      continue;
    }
    const fields: BodyField[] = [];
    for (const [name, schema] of entries) {
      const file = await isFileSchema(schema);
      fields.push({
        name,
        schema,
        file,
        freeText: !file && isFreeTextField(schema),
        optional: await isOptional(schema),
      });
    }
    if (!fields.some(({ file }) => file)) {
      continue;
    }
    handlers.push({
      file: id.startsWith(HANDLERS_PREFIX)
        ? id.slice(HANDLERS_PREFIX.length)
        : id,
      body,
      fields,
      stringFields: fields
        .filter(({ freeText }) => freeText)
        .map(({ name }) => name),
    });
  }

  return { handlers, importErrors };
};

const buildForm = async (
  fields: readonly BodyField[],
  stringValue: string,
): Promise<FormData> => {
  const form = new FormData();
  for (const { name, schema, file, freeText, optional } of fields) {
    if (file) {
      form.append(name, probeFile());
      continue;
    }
    if (freeText) {
      form.append(name, stringValue);
      continue;
    }
    if (optional) {
      continue;
    }
    const value = await filler(schema);
    if (value !== null) {
      form.append(name, value);
    }
  }
  return form;
};

type ProbeOutcome = { status: number; detail: string };

/**
 * Serves the schema on the production HTTP core behind the production error
 * boundary, so the probe exercises the real body reader, decoder and refusal
 * rather than a stand-in.
 */
const serveProbe = (body: v.GenericSchema): TestServer =>
  serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({
        "/probe": { POST: defineEndpoint.public({ body }, () => "ok") },
      }),
    }),
  );

const postForm = async (
  server: TestServer,
  form: FormData,
): Promise<ProbeOutcome> => {
  const response = await server.fetch(
    new Request("http://localhost/probe", { method: "POST", body: form }),
  );
  const detail = response.status === 200 ? "" : await response.text();
  return { status: response.status, detail: detail.slice(0, 300) };
};

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

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
      // source-text scan misses, so pin one: `entities/versions/upload.ts` names
      // no file field of its own, it imports `uploadVersionBodySchema`.
      expect(handlers.map(({ file }) => file)).toContain(
        "entities/versions/upload.ts",
      );

      const offenders: string[] = [];
      for (const { file, body, fields, stringFields } of handlers) {
        if (stringFields.length === 0) {
          continue;
        }
        const server = serveProbe(body);
        servers.push(server);
        // Baseline: the probe request itself must be valid with plain strings,
        // otherwise a failure below would say nothing about JSON parsing.
        const baseline = await postForm(
          server,
          await buildForm(fields, PLAIN_VALUE),
        );
        expect(`${file}: baseline ${baseline.status} ${baseline.detail}`).toBe(
          `${file}: baseline 200 `,
        );

        const probe = await postForm(
          server,
          await buildForm(fields, JSON_SHAPED_VALUE),
        );
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
