import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020";
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

// What the provider APIs accept, read from their own published
// specifications: `scripts/provider-request-schemas.ts` extracts each
// endpoint's request schema into `src/tests/fixtures/provider-request-schemas`
// with the source's URL, retrieval date and sha256 beside it. A request an
// adapter sends is held to the schema of the endpoint it calls, so a body a
// provider would refuse fails here instead of on the provider's side.

const SCHEMA_DIR = path.resolve(
  import.meta.dir,
  "../fixtures/provider-request-schemas",
);

/** Every endpoint the chat adapters call, by the request that reaches it. */
const ENDPOINTS = [
  {
    schema: "openai.responses",
    host: /^api\.openai\.com$/u,
    path: /^\/v1\/responses$/u,
  },
  {
    schema: "anthropic.messages",
    host: /^api\.anthropic\.com$/u,
    path: /^\/v1\/messages$/u,
  },
  {
    schema: "google.generate-content",
    host: /^generativelanguage\.googleapis\.com$/u,
    path: /^\/v1beta\/models\/[^/]+:(?:stream)?[gG]enerateContent$/u,
  },
  {
    schema: "mistral.chat-completions",
    host: /^api\.mistral\.ai$/u,
    path: /^\/v1\/chat\/completions$/u,
  },
  {
    schema: "openrouter.chat-completions",
    host: /^openrouter\.ai$/u,
    path: /^\/api\/v1\/chat\/completions$/u,
  },
  {
    schema: "bedrock.converse-stream",
    host: /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cassette\.invalid)?$/u,
    path: /^\/model\/[^/]+\/converse-stream$/u,
  },
  {
    schema: "bedrock.converse",
    host: /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cassette\.invalid)?$/u,
    path: /^\/model\/[^/]+\/converse$/u,
  },
] as const;

export type ProviderRequestSchemaId = (typeof ENDPOINTS)[number]["schema"];

/** A request as it left the process. */
export type SentProviderRequest = {
  body: string;
  method: string;
  url: string;
};

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(file, "utf-8"));

/** Every `format` a schema names, so the ones the validator does not know
 *  can be read as annotations. */
const formatsOf = (node: unknown, into: Set<string>): Set<string> => {
  if (isUnknownArray(node)) {
    for (const item of node) {
      formatsOf(item, into);
    }
  } else if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "format" && typeof value === "string") {
        into.add(value);
      } else {
        formatsOf(value, into);
      }
    }
  }
  return into;
};

type LoadedSchema = { label: string; validate: ValidateFunction };

/** Compiles every vendored schema once. */
const loadSchemas = (): ReadonlyMap<ProviderRequestSchemaId, LoadedSchema> => {
  // Not strict: the schemas are the providers' own, and a keyword Ajv does
  // not know is theirs to use.
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    logger: false,
    strict: false,
  });
  addFormats(ajv);
  const loaded = new Map<ProviderRequestSchemaId, LoadedSchema>();
  for (const { schema: id } of ENDPOINTS) {
    const schema = readJson(path.join(SCHEMA_DIR, `${id}.schema.json`));
    const sidecar = readJson(path.join(SCHEMA_DIR, `${id}.source.json`));
    if (!isRecord(schema) || !isRecord(sidecar)) {
      return panic(`${id}: the vendored schema and its source are objects`);
    }
    const label = sidecar["label"];
    if (typeof label !== "string") {
      return panic(`${id}: the source names its label`);
    }
    for (const format of formatsOf(schema, new Set())) {
      if (ajv.formats[format] === undefined) {
        ajv.addFormat(format, true);
      }
    }
    loaded.set(id, { label, validate: ajv.compile(schema) });
  }
  return loaded;
};

let schemas: ReadonlyMap<ProviderRequestSchemaId, LoadedSchema> | undefined;
const schemaFor = (id: ProviderRequestSchemaId): LoadedSchema => {
  schemas ??= loadSchemas();
  return schemas.get(id) ?? panic(`No vendored schema ${id}`);
};

/** A JSON pointer as the body path a failure names: `body.input[0].role`. */
const bodyPathOf = (instancePath: string): string =>
  `body${instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((segment) => (/^\d+$/u.test(segment) ? `[${segment}]` : `.${segment}`))
    .join("")}`;

/** The rule one validation error names, with the value it concerns. */
const ruleOf = (error: ErrorObject): string => {
  const { params } = error;
  const message = error.message ?? error.keyword;
  switch (error.keyword) {
    case "additionalProperties": {
      return `${message} (${String(Reflect.get(params, "additionalProperty"))})`;
    }
    case "enum": {
      return `${message} ${JSON.stringify(Reflect.get(params, "allowedValues"))}`;
    }
    default: {
      return message;
    }
  }
};

/** The vendored schema of the endpoint `request` calls, if there is one. */
export const requestSchemaIdOf = (
  request: SentProviderRequest,
): ProviderRequestSchemaId | undefined => {
  const url = new URL(request.url);
  return ENDPOINTS.find(
    ({ host, path: endpointPath }) =>
      host.test(url.hostname) && endpointPath.test(url.pathname),
  )?.schema;
};

const parseBody = (text: string): { body: unknown; parsed: boolean } => {
  try {
    return { body: JSON.parse(text), parsed: true };
  } catch {
    return { body: undefined, parsed: false };
  }
};

/**
 * Where `request` breaks the published schema of the endpoint it calls, one
 * line per rule: `openai responses: body.metadata.x must be string`. A
 * request to an endpoint with no vendored schema is a finding too.
 */
export const findRequestSchemaViolations = (
  request: SentProviderRequest,
): string[] => {
  const url = new URL(request.url);
  const id = requestSchemaIdOf(request);
  if (id === undefined || request.method.toUpperCase() !== "POST") {
    return [
      `${request.method} ${url.host}${url.pathname}: no published request schema is vendored for this endpoint`,
    ];
  }
  const { label, validate } = schemaFor(id);
  const { body, parsed } = parseBody(request.body);
  if (!parsed) {
    return [`${label}: the body is not JSON`];
  }
  if (validate(body)) {
    return [];
  }
  return [
    ...new Set(
      (validate.errors ?? []).map(
        (error) =>
          `${label}: ${bodyPathOf(error.instancePath)} ${ruleOf(error)}`,
      ),
    ),
  ];
};

// --- Documented rules the schemas leave out -----------------------------------

/** OpenAI's `Metadata`: "Set of 16 key-value pairs ... Keys are strings with
 *  a maximum length of 64 characters. Values are strings with a maximum
 *  length of 512 characters." (the schema's own description, openai-openapi) */
const OPENAI_METADATA_LIMITS = { keys: 16, keyLength: 64, valueLength: 512 };
/** OpenAI's function name: "Must be a-z, A-Z, 0-9, or contain underscores
 *  and dashes, with a maximum length of 64." (`FunctionObject.name`,
 *  openai-openapi) */
const OPENAI_FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/u;

const openAiResponsesRules = (body: Record<string, unknown>): string[] => {
  const label = "openai responses";
  const findings: string[] = [];
  const metadata = body["metadata"];
  if (isRecord(metadata)) {
    const entries = Object.entries(metadata);
    if (entries.length > OPENAI_METADATA_LIMITS.keys) {
      findings.push(
        `${label}: body.metadata must have at most ${String(OPENAI_METADATA_LIMITS.keys)} keys`,
      );
    }
    for (const [key, value] of entries) {
      if (key.length > OPENAI_METADATA_LIMITS.keyLength) {
        findings.push(
          `${label}: body.metadata key ${key} must be at most ${String(OPENAI_METADATA_LIMITS.keyLength)} characters`,
        );
      }
      if (
        typeof value === "string" &&
        value.length > OPENAI_METADATA_LIMITS.valueLength
      ) {
        findings.push(
          `${label}: body.metadata.${key} must be at most ${String(OPENAI_METADATA_LIMITS.valueLength)} characters`,
        );
      }
    }
  }
  const tools = body["tools"];
  if (isUnknownArray(tools)) {
    for (const [index, tool] of tools.entries()) {
      const name = isRecord(tool) ? tool["name"] : undefined;
      if (
        isRecord(tool) &&
        tool["type"] === "function" &&
        (typeof name !== "string" || !OPENAI_FUNCTION_NAME.test(name))
      ) {
        findings.push(
          `${label}: body.tools[${String(index)}].name must match ${OPENAI_FUNCTION_NAME.source}`,
        );
      }
    }
  }
  return findings;
};

/** The provider's documented rules its published schema does not state. */
const DOCUMENTED_RULES: Partial<
  Record<ProviderRequestSchemaId, (body: Record<string, unknown>) => string[]>
> = {
  "openai.responses": openAiResponsesRules,
};

/**
 * Violations a provider's live API is known to accept though its published
 * schema forbids them, each with the evidence. The provider request schema
 * test fails an entry the requests no longer produce.
 */
export const ACCEPTED_BEYOND_SCHEMA: readonly {
  reason: string;
  schema: ProviderRequestSchemaId;
  violation: string;
}[] = [
  {
    schema: "mistral.chat-completions",
    violation:
      "mistral chat completions: body must NOT have additional properties (stream_options)",
    reason:
      "The adapter asks for streamed usage on every request, and every recorded Mistral response in the provider wire corpus answered such a request.",
  },
];

/**
 * Where `request` breaks what its provider accepts: the published schema of
 * the endpoint it calls and the documented rules the schema leaves out, less
 * the deviations the live API is known to accept.
 */
export const findProviderRuleViolations = (
  request: SentProviderRequest,
): string[] => {
  const id = requestSchemaIdOf(request);
  const { body } = parseBody(request.body);
  const documented =
    id !== undefined && isRecord(body)
      ? (DOCUMENTED_RULES[id]?.(body) ?? [])
      : [];
  return [...findRequestSchemaViolations(request), ...documented].filter(
    (violation) =>
      !ACCEPTED_BEYOND_SCHEMA.some((entry) => entry.violation === violation),
  );
};
