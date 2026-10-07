import { panic } from "better-result";
// Extracts the request schema of every provider API the chat adapters call
// from the provider's own published specification, as a self-contained JSON
// Schema (draft 2020-12) under src/tests/fixtures/provider-request-schemas.
// Each schema has a `.source.json` sidecar naming the specification's URL,
// the date it was retrieved and the sha256 of its content (keys sorted). The
// provider request schema test validates what the real adapters send against
// these files, with no network.
//
//   bun scripts/provider-request-schemas.ts --write
//
// downloads every specification and rewrites the extracted schemas and their
// sidecars. A schema whose source is unchanged keeps its retrieval date, so a
// refresh only shows what the providers changed. Review the diff before
// committing.
//
// Only what validates a request is kept: descriptions, examples, vendor
// extensions and other annotations are dropped, and OpenAPI's `nullable`
// becomes a `null` type. Google's discovery format and the AWS service model
// are translated keyword by keyword; the notes in each sidecar say where the
// translation reads more than the format states.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..");

export const PROVIDER_REQUEST_SCHEMA_DIR = path.resolve(
  import.meta.dir,
  "../src/tests/fixtures/provider-request-schemas",
);

type JsonObject = Record<string, unknown>;

/** Where a source's request schema sits inside its specification. */
type Selection =
  | { format: "openapi"; method: "post"; path: string }
  | { format: "google-discovery"; methodId: string }
  | { format: "aws-service-model"; operation: string };

export type RequestSchemaSource = {
  /** The fixture's file stem. */
  id: string;
  /** How a failure names the API: the provider, then the endpoint. */
  label: string;
  selection: Selection;
  /** The specification, or how to find it. */
  url: string | (() => Promise<string>);
  /** Where the extracted schema reads more than the specification states. */
  notes?: readonly string[] | undefined;
};

const ANTHROPIC_STATS_URL =
  "https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/.stats.yml";
/**
 * The last specification the SDK's `.stats.yml` named: later revisions stopped
 * publishing `openapi_spec_url` (last named at commit f31cbb5a, 2026-09-02).
 */
const ANTHROPIC_LAST_PUBLISHED_SPEC_URL =
  "https://storage.googleapis.com/stainless-sdk-openapi-specs/anthropic/anthropic-465bff21a179090915396565d1ae8f705cf8596e2ec920eb121072f25b8a7d68.yml";

/** The URL the Anthropic SDK's `.stats.yml` publishes, or the last one it
 *  did. */
const anthropicSpecUrl = async (): Promise<string> => {
  const stats = await fetchText(ANTHROPIC_STATS_URL);
  const named = /^openapi_spec_url:\s*(\S+)\s*$/mu.exec(stats)?.[1];
  return named ?? ANTHROPIC_LAST_PUBLISHED_SPEC_URL;
};

const BOTOCORE_BEDROCK_RUNTIME_URL =
  "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/bedrock-runtime/2023-09-30/service-2.json";

export const REQUEST_SCHEMA_SOURCES = [
  {
    id: "openai.responses",
    label: "openai responses",
    selection: { format: "openapi", method: "post", path: "/responses" },
    url: "https://raw.githubusercontent.com/openai/openai-openapi/main/openapi.yaml",
  },
  {
    id: "anthropic.messages",
    label: "anthropic messages",
    // The adapter calls the beta endpoint.
    selection: {
      format: "openapi",
      method: "post",
      path: "/v1/messages?beta=true",
    },
    url: anthropicSpecUrl,
    notes: [
      "The source is the OpenAPI specification the official TypeScript SDK's .stats.yml names (openapi_spec_url); when it names none, the last one it named.",
    ],
  },
  {
    id: "google.generate-content",
    label: "google generateContent",
    selection: {
      format: "google-discovery",
      methodId: "generativelanguage.models.streamGenerateContent",
    },
    url: "https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta",
    notes: [
      "Translated from Google's discovery format. An object with declared properties refuses any other property, as the API refuses an unknown field name. An int64 or uint64 field accepts a JSON string or integer, as Google's JSON mapping does.",
    ],
  },
  {
    id: "mistral.chat-completions",
    label: "mistral chat completions",
    selection: {
      format: "openapi",
      method: "post",
      path: "/v1/chat/completions",
    },
    url: "https://docs.mistral.ai/openapi.yaml",
  },
  {
    id: "openrouter.chat-completions",
    label: "openrouter chat completions",
    selection: { format: "openapi", method: "post", path: "/chat/completions" },
    url: "https://openrouter.ai/openapi.json",
  },
  {
    id: "bedrock.converse-stream",
    label: "bedrock converse-stream",
    selection: { format: "aws-service-model", operation: "ConverseStream" },
    url: BOTOCORE_BEDROCK_RUNTIME_URL,
    notes: [
      "Translated from the AWS service model (botocore). Only body members are kept; a union accepts exactly one member; a blob is its base64 string.",
    ],
  },
  {
    id: "bedrock.converse",
    label: "bedrock converse",
    selection: { format: "aws-service-model", operation: "Converse" },
    url: BOTOCORE_BEDROCK_RUNTIME_URL,
    notes: [
      "Translated from the AWS service model (botocore). Only body members are kept; a union accepts exactly one member; a blob is its base64 string.",
    ],
  },
] as const satisfies readonly RequestSchemaSource[];

export type RequestSchemaId = (typeof REQUEST_SCHEMA_SOURCES)[number]["id"];

// --- Fetching -----------------------------------------------------------------

const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 60_000;

/** One download of `url`: its body, or why there is none. */
const downloadOnce = async (
  url: string,
): Promise<{ bytes: Uint8Array } | { problem: string }> =>
  await fetch(url, {
    redirect: "follow",
    // A host that stalls mid-response fails the attempt instead of hanging
    // it; the signal bounds the body read too.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).then(
    async (response) =>
      response.ok
        ? { bytes: new Uint8Array(await response.arrayBuffer()) }
        : { problem: `HTTP ${String(response.status)}` },
    (error: unknown) => ({
      problem: error instanceof Error ? error.message : String(error),
    }),
  );

/** The body at `url`, retried a few times; a lasting failure throws. */
export const fetchBytes = async (
  url: string,
  attempt = 1,
): Promise<Uint8Array> => {
  const outcome = await downloadOnce(url);
  if ("bytes" in outcome) {
    return outcome.bytes;
  }
  if (attempt >= FETCH_ATTEMPTS) {
    return panic(
      `Could not download ${url} after ${String(FETCH_ATTEMPTS)} attempts: ${outcome.problem}`,
    );
  }
  await Bun.sleep(RETRY_DELAY_MS * attempt);
  return await fetchBytes(url, attempt + 1);
};

const fetchText = async (url: string): Promise<string> =>
  new TextDecoder().decode(await fetchBytes(url));

/** `value` with every object's keys sorted. */
export const canonicalJson = (value: unknown): unknown => {
  if (isUnknownArray(value)) {
    return value.map(canonicalJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalJson(value[key])]),
  );
};

/**
 * The sha256 of a specification's content: the parsed document serialized
 * with its keys sorted. Some sources (Google's discovery service) order keys
 * differently on every download, so the bytes alone would never match.
 */
export const specificationSha256 = (spec: JsonObject): string =>
  hashSha256Hex(JSON.stringify(canonicalJson(spec)));

/** A specification as JSON, whichever of JSON or YAML it is written in. */
export const parseSpecification = (text: string): JsonObject => {
  const trimmed = text.trimStart();
  const parsed: unknown = trimmed.startsWith("{")
    ? JSON.parse(trimmed)
    : Bun.YAML.parse(text);
  return isRecord(parsed)
    ? parsed
    : panic("A specification is a JSON or YAML object");
};

// --- Shared -----------------------------------------------------------------

const DEFS_POINTER = "#/$defs/";

const objectAt = (value: unknown, where: string): JsonObject =>
  isRecord(value) ? value : panic(`Expected an object at ${where}`);

const documentOf = (root: string, defs: Map<string, unknown>): JsonObject => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $ref: `${DEFS_POINTER}${root}`,
  $defs: Object.fromEntries(defs),
});

/** Whether `pattern` compiles the way the validator compiles it. */
const isUsablePattern = (pattern: string): boolean => {
  try {
    // oxlint-disable-next-line no-new -- only compiles the pattern
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
};

// --- OpenAPI ----------------------------------------------------------------

const COMPONENT_POINTER = "#/components/schemas/";

/** Keywords whose value is a map of subschemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LIST_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
/** Keywords whose value is one subschema (or, for some, a boolean). */
const SCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
/** Annotations: they validate nothing. */
const ANNOTATION_KEYWORDS = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "discriminator",
  "example",
  "examples",
  "externalDocs",
  "readOnly",
  "title",
  "writeOnly",
  "xml",
]);

const withNull = (schema: JsonObject): JsonObject => {
  const type = schema["type"];
  if (typeof type === "string") {
    return type === "null" ? schema : { ...schema, type: [type, "null"] };
  }
  if (isUnknownArray(type)) {
    return type.includes("null")
      ? schema
      : { ...schema, type: [...type, "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
};

/** One OpenAPI schema as plain JSON Schema, queuing every component it
 *  references. */
const openApiSchema = (
  node: unknown,
  enqueue: (name: string) => void,
): unknown => {
  if (typeof node === "boolean") {
    return node;
  }
  if (!isRecord(node)) {
    return panic("An OpenAPI schema is an object or a boolean");
  }
  const out: JsonObject = {};
  let nullable = false;
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword.startsWith("x-") || ANNOTATION_KEYWORDS.has(keyword)) {
      continue;
    }
    if (keyword === "nullable") {
      nullable = value === true;
      continue;
    }
    if (keyword === "$ref") {
      if (typeof value !== "string" || !value.startsWith(COMPONENT_POINTER)) {
        return panic(`Unsupported reference ${String(value)}`);
      }
      const name = value.slice(COMPONENT_POINTER.length);
      enqueue(name);
      out[keyword] = `${DEFS_POINTER}${name}`;
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
      out[keyword] = Object.fromEntries(
        Object.entries(objectAt(value, keyword)).map(([name, schema]) => [
          name,
          openApiSchema(schema, enqueue),
        ]),
      );
      continue;
    }
    if (SCHEMA_LIST_KEYWORDS.has(keyword) && isUnknownArray(value)) {
      // The specifications' `oneOf` branches overlap (a message matches both
      // the short and the long message shape), and the APIs pick a branch by
      // its discriminator, so a value is read as matching at least one.
      const schemas = value.map((schema) => openApiSchema(schema, enqueue));
      if (keyword === "allOf") {
        out[keyword] = [
          ...schemas,
          ...(isUnknownArray(out["allOf"]) ? out["allOf"] : []),
        ];
      } else if (keyword !== "oneOf") {
        out[keyword] = schemas;
      } else if ("anyOf" in node) {
        out["allOf"] = [
          ...(isUnknownArray(out["allOf"]) ? out["allOf"] : []),
          { anyOf: schemas },
        ];
      } else {
        out["anyOf"] = schemas;
      }
      continue;
    }
    if (SCHEMA_KEYWORDS.has(keyword)) {
      out[keyword] = isUnknownArray(value)
        ? value.map((schema) => openApiSchema(schema, enqueue))
        : openApiSchema(value, enqueue);
      continue;
    }
    if (keyword === "pattern" && typeof value === "string") {
      if (isUsablePattern(value)) {
        out[keyword] = value;
      }
      continue;
    }
    out[keyword] = value;
  }
  return nullable ? withNull(out) : out;
};

const extractOpenApi = (
  spec: JsonObject,
  selection: Extract<Selection, { format: "openapi" }>,
): JsonObject => {
  const operation = objectAt(
    objectAt(objectAt(spec["paths"], "paths")[selection.path], selection.path)[
      selection.method
    ],
    `${selection.path} ${selection.method}`,
  );
  const content = objectAt(
    objectAt(operation["requestBody"], "requestBody")["content"],
    "requestBody.content",
  );
  const body = objectAt(content["application/json"], "application/json");
  const bodySchema = objectAt(body["schema"], "requestBody schema");
  const components = objectAt(
    objectAt(spec["components"], "components")["schemas"],
    "components.schemas",
  );
  const defs = new Map<string, unknown>();
  const queue: string[] = [];
  const enqueue = (name: string) => {
    if (!defs.has(name) && !queue.includes(name)) {
      queue.push(name);
    }
  };
  const ref = bodySchema["$ref"];
  const root =
    typeof ref === "string" && ref.startsWith(COMPONENT_POINTER)
      ? ref.slice(COMPONENT_POINTER.length)
      : "RequestBody";
  if (root === "RequestBody") {
    defs.set(root, openApiSchema(bodySchema, enqueue));
  } else {
    enqueue(root);
  }
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    defs.set(
      name,
      openApiSchema(components[name] ?? panic(`No schema ${name}`), enqueue),
    );
  }
  return documentOf(root, defs);
};

// --- Google discovery -------------------------------------------------------

const INT64_FORMATS = new Set(["int64", "uint64"]);

const discoverySchema = (
  node: unknown,
  enqueue: (name: string) => void,
): JsonObject => {
  const schema = objectAt(node, "discovery schema");
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    enqueue(ref);
    return { $ref: `${DEFS_POINTER}${ref}` };
  }
  const type = schema["type"];
  const format = schema["format"];
  switch (type) {
    case "any": {
      return {};
    }
    case "array": {
      return {
        type: "array",
        items: discoverySchema(schema["items"], enqueue),
      };
    }
    case "object": {
      const out: JsonObject = { type: "object" };
      const properties = schema["properties"];
      if (isRecord(properties)) {
        out["properties"] = Object.fromEntries(
          Object.entries(properties).map(([name, property]) => [
            name,
            discoverySchema(property, enqueue),
          ]),
        );
      }
      const additional = schema["additionalProperties"];
      if (isRecord(additional)) {
        out["additionalProperties"] = discoverySchema(additional, enqueue);
      } else if (isRecord(properties)) {
        out["additionalProperties"] = false;
      }
      return out;
    }
    case "string": {
      if (typeof format === "string" && INT64_FORMATS.has(format)) {
        return { type: ["string", "integer"] };
      }
      const out: JsonObject = { type: "string" };
      if (isUnknownArray(schema["enum"])) {
        out["enum"] = schema["enum"];
      }
      const pattern = schema["pattern"];
      if (typeof pattern === "string" && isUsablePattern(pattern)) {
        out["pattern"] = pattern;
      }
      return out;
    }
    case "integer":
    case "number":
    case "boolean": {
      return { type };
    }
    default: {
      return panic(`Unsupported discovery type ${String(type)}`);
    }
  }
};

const findDiscoveryMethod = (
  resources: unknown,
  methodId: string,
): JsonObject | undefined => {
  if (!isRecord(resources)) {
    return undefined;
  }
  for (const resource of Object.values(resources)) {
    if (!isRecord(resource)) {
      continue;
    }
    const methods = resource["methods"];
    if (isRecord(methods)) {
      for (const method of Object.values(methods)) {
        if (isRecord(method) && method["id"] === methodId) {
          return method;
        }
      }
    }
    const nested = findDiscoveryMethod(resource["resources"], methodId);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
};

const extractDiscovery = (
  spec: JsonObject,
  selection: Extract<Selection, { format: "google-discovery" }>,
): JsonObject => {
  const method =
    findDiscoveryMethod(spec["resources"], selection.methodId) ??
    panic(`No discovery method ${selection.methodId}`);
  const root = objectAt(method["request"], "request")["$ref"];
  if (typeof root !== "string") {
    return panic(`${selection.methodId} names no request schema`);
  }
  const schemas = objectAt(spec["schemas"], "schemas");
  const defs = new Map<string, unknown>();
  const queue: string[] = [root];
  const enqueue = (name: string) => {
    if (!defs.has(name) && !queue.includes(name)) {
      queue.push(name);
    }
  };
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    defs.set(
      name,
      discoverySchema(schemas[name] ?? panic(`No schema ${name}`), enqueue),
    );
  }
  return documentOf(root, defs);
};

// --- AWS service model (botocore) -------------------------------------------

const numberLimit = (
  shape: JsonObject,
  from: string,
  to: string,
): JsonObject => {
  const limit = shape[from];
  return typeof limit === "number" ? { [to]: limit } : {};
};

const awsShapeSchema = (
  shape: JsonObject,
  enqueue: (name: string) => void,
): JsonObject => {
  const memberRef = (member: unknown): JsonObject => {
    const name = objectAt(member, "member")["shape"];
    if (typeof name !== "string") {
      return panic("A member names its shape");
    }
    enqueue(name);
    return { $ref: `${DEFS_POINTER}${name}` };
  };
  const type = shape["type"];
  switch (type) {
    case "structure": {
      const members = objectAt(shape["members"], "members");
      const properties: JsonObject = {};
      const bodyNames = new Map<string, string>();
      for (const [name, member] of Object.entries(members)) {
        const spec = objectAt(member, name);
        // Path, header and query members are not in the body.
        if (typeof spec["location"] === "string") {
          continue;
        }
        const jsonName =
          typeof spec["locationName"] === "string"
            ? spec["locationName"]
            : name;
        bodyNames.set(name, jsonName);
        properties[jsonName] = memberRef(spec);
      }
      const required = isUnknownArray(shape["required"])
        ? shape["required"].flatMap((name) =>
            typeof name === "string" && bodyNames.has(name)
              ? [bodyNames.get(name) ?? name]
              : [],
          )
        : [];
      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...(shape["union"] === true
          ? { minProperties: 1, maxProperties: 1 }
          : {}),
      };
    }
    case "list": {
      return {
        type: "array",
        items: memberRef(shape["member"]),
        ...numberLimit(shape, "min", "minItems"),
        ...numberLimit(shape, "max", "maxItems"),
      };
    }
    case "map": {
      return {
        type: "object",
        propertyNames: memberRef(shape["key"]),
        additionalProperties: memberRef(shape["value"]),
        ...numberLimit(shape, "min", "minProperties"),
        ...numberLimit(shape, "max", "maxProperties"),
      };
    }
    case "string": {
      const pattern = shape["pattern"];
      return {
        type: "string",
        ...(isUnknownArray(shape["enum"]) ? { enum: shape["enum"] } : {}),
        ...(typeof pattern === "string" && isUsablePattern(pattern)
          ? { pattern }
          : {}),
        ...numberLimit(shape, "min", "minLength"),
        ...numberLimit(shape, "max", "maxLength"),
      };
    }
    case "integer":
    case "long": {
      return {
        type: "integer",
        ...numberLimit(shape, "min", "minimum"),
        ...numberLimit(shape, "max", "maximum"),
      };
    }
    case "float":
    case "double": {
      return {
        type: "number",
        ...numberLimit(shape, "min", "minimum"),
        ...numberLimit(shape, "max", "maximum"),
      };
    }
    case "boolean": {
      return { type: "boolean" };
    }
    case "blob": {
      return { type: "string" };
    }
    case "timestamp": {
      return { type: ["string", "number"] };
    }
    case "document": {
      return {};
    }
    default: {
      return panic(`Unsupported AWS shape type ${String(type)}`);
    }
  }
};

const extractAwsServiceModel = (
  spec: JsonObject,
  selection: Extract<Selection, { format: "aws-service-model" }>,
): JsonObject => {
  const operation = objectAt(
    objectAt(spec["operations"], "operations")[selection.operation],
    selection.operation,
  );
  const root = objectAt(operation["input"], "input")["shape"];
  if (typeof root !== "string") {
    return panic(`${selection.operation} names no input shape`);
  }
  const shapes = objectAt(spec["shapes"], "shapes");
  const defs = new Map<string, unknown>();
  const queue: string[] = [root];
  const enqueue = (name: string) => {
    if (!defs.has(name) && !queue.includes(name)) {
      queue.push(name);
    }
  };
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    defs.set(name, awsShapeSchema(objectAt(shapes[name], name), enqueue));
  }
  return documentOf(root, defs);
};

// --- Extraction -------------------------------------------------------------

/** The request schema `selection` names in `spec`. */
export const extractRequestSchema = (
  spec: JsonObject,
  selection: Selection,
): JsonObject => {
  switch (selection.format) {
    case "openapi": {
      return extractOpenApi(spec, selection);
    }
    case "google-discovery": {
      return extractDiscovery(spec, selection);
    }
    case "aws-service-model": {
      return extractAwsServiceModel(spec, selection);
    }
    default: {
      selection satisfies never;
      return panic("Unhandled specification format");
    }
  }
};

export type RequestSchemaSidecar = {
  label: string;
  /** Where the request schema sits in the specification. */
  selection: Selection;
  /** `sha256` is `specificationSha256` of the document at `url`. */
  source: { retrievedAt: string; sha256: string; url: string };
  extractedBy: string;
  notes?: readonly string[] | undefined;
};

export const schemaPath = (id: string): string =>
  path.join(PROVIDER_REQUEST_SCHEMA_DIR, `${id}.schema.json`);
export const sidecarPath = (id: string): string =>
  path.join(PROVIDER_REQUEST_SCHEMA_DIR, `${id}.source.json`);

const toJsonText = (value: unknown): string =>
  `${JSON.stringify(canonicalJson(value), null, 2)}\n`;

/** The source a committed sidecar records, if there is one. */
export const readRecordedSource = (
  id: string,
): RequestSchemaSidecar["source"] | undefined => {
  const file = sidecarPath(id);
  if (!existsSync(file)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  const source = isRecord(parsed) ? parsed["source"] : undefined;
  if (!isRecord(source)) {
    return undefined;
  }
  const { retrievedAt, sha256, url } = source;
  return typeof retrievedAt === "string" &&
    typeof sha256 === "string" &&
    typeof url === "string"
    ? { retrievedAt, sha256, url }
    : undefined;
};

const resolveUrl = async (source: RequestSchemaSource): Promise<string> =>
  typeof source.url === "string" ? source.url : await source.url();

/** Downloads `source`'s specification once per URL. */
const createSpecificationCache = () => {
  const cache = new Map<string, Promise<JsonObject>>();
  return async (url: string) => {
    const cached = cache.get(url);
    if (cached !== undefined) {
      return await cached;
    }
    const loading = (async () =>
      parseSpecification(new TextDecoder().decode(await fetchBytes(url))))();
    cache.set(url, loading);
    return await loading;
  };
};

type Extracted = {
  schema: JsonObject;
  sha256: string;
  source: RequestSchemaSource;
  url: string;
};

/** Every source's request schema as its specification states it today. */
const extractAll = async (): Promise<Extracted[]> => {
  const load = createSpecificationCache();
  const sources: readonly RequestSchemaSource[] = REQUEST_SCHEMA_SOURCES;
  return await Promise.all(
    sources.map(async (source) => {
      const url = await resolveUrl(source);
      const spec = await load(url);
      return {
        schema: extractRequestSchema(spec, source.selection),
        sha256: specificationSha256(spec),
        source,
        url,
      };
    }),
  );
};

const writeAll = async () => {
  mkdirSync(PROVIDER_REQUEST_SCHEMA_DIR, { recursive: true });
  const today = Temporal.Now.plainDateISO("UTC").toString();
  for (const { schema, sha256, source, url } of await extractAll()) {
    const previous = readRecordedSource(source.id);
    const retrievedAt =
      previous?.sha256 === sha256 && previous.url === url
        ? previous.retrievedAt
        : today;
    const sidecar: RequestSchemaSidecar = {
      label: source.label,
      selection: source.selection,
      source: { retrievedAt, sha256, url },
      extractedBy: "apps/api/scripts/provider-request-schemas.ts",
      ...(source.notes === undefined ? {} : { notes: source.notes }),
    };
    writeFileSync(schemaPath(source.id), toJsonText(schema));
    writeFileSync(sidecarPath(source.id), toJsonText(sidecar));
    const defs = schema["$defs"];
    console.log(
      `${source.id}: ${String(isRecord(defs) ? Object.keys(defs).length : 0)} schemas from ${url} (sha256 ${sha256.slice(0, 12)})`,
    );
  }
  // Written as the repository's formatter writes them, so a refresh with no
  // upstream change leaves no diff.
  const formatted = Bun.spawnSync(
    [
      "bun",
      "--bun",
      "oxfmt",
      "-c",
      ".oxfmtrc.json",
      path.relative(REPOSITORY_ROOT, PROVIDER_REQUEST_SCHEMA_DIR),
    ],
    { cwd: REPOSITORY_ROOT, stderr: "inherit", stdout: "ignore" },
  );
  if (formatted.exitCode !== 0) {
    panic("Formatting the extracted schemas failed");
  }
};

// --- Drift check --------------------------------------------------------------

const MAX_LISTED_PATHS = 25;

/** The JSON pointers at which `left` and `right` differ. */
export const differingPaths = (
  left: unknown,
  right: unknown,
  at = "",
): string[] => {
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return [];
  }
  if (
    isUnknownArray(left) &&
    isUnknownArray(right) &&
    left.length === right.length
  ) {
    return left.flatMap((item, index) =>
      differingPaths(item, right[index], `${at}/${String(index)}`),
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    return keys
      .toSorted()
      .flatMap((key) =>
        differingPaths(
          left[key],
          right[key],
          `${at}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        ),
      );
  }
  return [at === "" ? "/" : at];
};

/** What changed upstream for one vendored schema; empty when nothing did. */
export const describeDrift = ({
  recorded,
  today,
  vendored,
}: {
  recorded: RequestSchemaSidecar["source"] | undefined;
  today: Extracted;
  vendored: unknown;
}): string[] => {
  const { source } = today;
  const name = `${source.id} (${source.label})`;
  if (recorded === undefined) {
    return [`[NOT VENDORED] ${name}: no sidecar is committed`];
  }
  const findings: string[] = [];
  if (recorded.url !== today.url) {
    findings.push(
      `[SOURCE MOVED] ${name}: the specification is now ${today.url} (vendored from ${recorded.url})`,
    );
  }
  const paths = differingPaths(
    canonicalJson(vendored),
    canonicalJson(today.schema),
  );
  if (paths.length > 0) {
    const listed = paths.slice(0, MAX_LISTED_PATHS).join(", ");
    const more =
      paths.length > MAX_LISTED_PATHS
        ? ` and ${String(paths.length - MAX_LISTED_PATHS)} more`
        : "";
    findings.push(
      `[REQUEST SCHEMA CHANGED] ${name}: ${String(paths.length)} path(s) differ: ${listed}${more}`,
    );
  }
  if (recorded.sha256 !== today.sha256) {
    const unchanged =
      paths.length === 0 ? "; the request schema it yields is unchanged" : "";
    findings.push(
      `[SPECIFICATION CHANGED] ${name}: sha256 ${recorded.sha256.slice(0, 12)} -> ${today.sha256.slice(0, 12)}${unchanged}`,
    );
  }
  return findings;
};

const appendSummary = (lines: readonly string[]) => {
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") {
    appendFileSync(summary, `${lines.join("\n")}\n`);
  }
};

const readVendoredSchema = (id: string): unknown =>
  existsSync(schemaPath(id))
    ? JSON.parse(readFileSync(schemaPath(id), "utf-8"))
    : undefined;

const checkAll = async () => {
  const findings = (await extractAll()).flatMap((today) =>
    describeDrift({
      recorded: readRecordedSource(today.source.id),
      today,
      vendored: readVendoredSchema(today.source.id),
    }),
  );
  if (findings.length === 0) {
    const message =
      "✓ Every vendored provider request schema matches its published specification.";
    console.log(message);
    appendSummary([message]);
    return;
  }
  const report = [
    `✗ ${String(findings.length)} provider specification change(s):`,
    ...findings.map((finding) => `  ✗ ${finding}`),
    "",
    "Refresh with `bun scripts/provider-request-schemas.ts --write` in apps/api",
    "(or run the workflow with update=true), review the schema diff, and run",
    "the provider request schema test before committing.",
  ];
  console.error(report.join("\n"));
  appendSummary(["```", ...report, "```"]);
  process.exit(1);
};

if (import.meta.main) {
  const argumentsGiven = Bun.argv.slice(2);
  if (argumentsGiven.includes("--write")) {
    await writeAll();
  } else if (argumentsGiven.includes("--check")) {
    await checkAll();
  } else {
    console.error(
      "Usage: bun scripts/provider-request-schemas.ts --write | --check",
    );
    process.exit(2);
  }
}
