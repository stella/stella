/**
 * A tool surface with lazy discovery. The frequent tools are listed directly
 * with compact schemas; the rest stay out of `tools/list` and are reached
 * through three capability tools, so a turn pays only for what is listed:
 *
 * - `list_capabilities` pages the unlisted tools: id, summary, access.
 * - `describe_capability` returns a bounded outline, or the full input schema on request
 *   (listed tools included, whose listed schema is the compact one).
 * - `invoke_capability` reads arguments using the canonical schema;
 *   `validate_only` checks argument reading without running the handler.
 *
 * Every tool is also callable by its own name. Calls are read through
 * `readToolInput` and answered with `toCallResult`'s one envelope.
 */

import { panic, Result } from "better-result";

import {
  closestNames,
  didYouMean,
  failure,
  KIT_ERROR_CODES,
  KIT_INTERNAL_MESSAGE,
  jsonSuccess,
  success,
  toCallResult,
  validationError,
} from "./envelope";
import { assertToolInputSchema, readToolInput } from "./input";
import { compactSchema } from "./schema";
import type {
  McpJsonSchema,
  ListedTool,
  ToolCallResult,
  ToolDefinition,
  ToolOutcome,
} from "./types";

/** Names of the three MCP discovery and invocation tools. */
export const CAPABILITY_TOOL_NAMES = {
  list: "list_capabilities",
  describe: "describe_capability",
  invoke: "invoke_capability",
} as const;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const ACCESS_FILTERS = ["all", "read", "write"] as const;

const LIST_SCHEMA = {
  type: "object",
  properties: {
    domain: { type: "string" },
    access: { type: "string", enum: ACCESS_FILTERS },
    cursor: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT },
  },
} as const;

const DESCRIBE_SCHEMA = {
  type: "object",
  properties: {
    capability: { type: "string" },
    detail: { type: "string", enum: ["compact", "full"] },
  },
  required: ["capability"],
} as const;

const INVOKE_SCHEMA = {
  type: "object",
  properties: {
    capability: { type: "string" },
    input: { type: "object" },
    validate_only: { type: "boolean" },
  },
  required: ["capability"],
} as const;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/** Host-only metadata for rejected handlers and failed wire serialization. */
export type ToolFailureEvent = {
  readonly tool: string;
  readonly phase: "handler" | "serialization";
};

/** Synchronous host telemetry; causes are never included in tool responses. */
export type ToolFailureObserver = (
  cause: unknown,
  event: ToolFailureEvent,
) => undefined;

/** Registry used to construct a transport-independent tool surface. */
export type ToolSurfaceOptions<Context> = {
  readonly tools: readonly ToolDefinition<Context>[];
  readonly onError?: ToolFailureObserver;
  /** Bounded invocation skeleton by default; outline returns a type map and bare example. */
  readonly discovery?: { readonly type: "bounded" | "outline" };
  /** Full discovery uses the canonical input schema by default. */
  readonly fullSchema?: "input" | "described";
  /** Successful capability invocation wraps its payload in result by default. */
  readonly capabilityResult?: "wrapped" | "payload";
  /** Validate-only returns a reading receipt by default, or normalized input on request. */
  readonly validationResult?: "receipt" | "input";
  /** Detailed list DTO by default; minimal omits paging limit and false destructive flags. */
  readonly capabilityList?: "detailed" | "minimal";
  /** Fixed discovery descriptions by default, or descriptions enumerating lazy names. */
  readonly metaDescriptions?: "fixed" | "enumerated";
};

/** MCP listing and call handlers bound to a registry. */
export type ToolSurface<Context> = {
  /** What `tools/list` returns: the direct tools, then the capability tools. */
  readonly listTools: () => ListedTool[];
  readonly callTool: (
    name: string,
    args: unknown,
    context: Context,
  ) => Promise<ToolCallResult>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const destructiveOf = <Context>(tool: ToolDefinition<Context>): boolean =>
  tool.destructive ?? tool.access === "write";

const listedSchema = (schema: McpJsonSchema): ListedTool["inputSchema"] => ({
  ...compactSchema(schema),
  type: "object",
});

const COMPACT_DESCRIBE_BYTES = 2900;

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

type ParameterOutline = {
  name: string;
  type: unknown;
  required: boolean;
  enum?: unknown[];
};

/** Keep the outline bounded even when names, enum values, or nested schemas are large. */
const describeCompact = <Context>(tool: ToolDefinition<Context>) => {
  const schema = tool.describedSchema ?? tool.inputSchema;
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  const parameters: ParameterOutline[] = [];
  let description = "";
  let summaryLength = 0;
  const segments = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(tool.summary);
  for (const { segment } of segments) {
    const candidate = description + segment;
    if (summaryLength === 120 || jsonBytes(candidate) > 720) {
      break;
    }
    description = candidate;
    summaryLength += 1;
  }
  const outline = {
    id: tool.name,
    description,
    access: tool.access,
    destructive: destructiveOf(tool),
    parameters,
    omittedParameters: Object.keys(properties).length,
    example: { capability: tool.name, input: tool.exampleInput ?? {} },
    hint: 'Example is an invocation skeleton. Call describe_capability with detail="full" for constraints, nested fields, and guidance.',
  };
  if (jsonBytes(outline) >= COMPACT_DESCRIBE_BYTES) {
    outline.example.input = {};
  }
  for (const [name, property] of Object.entries(properties)) {
    const parameter: ParameterOutline = {
      name,
      type: isRecord(property)
        ? (property["type"] ?? "unspecified")
        : "unspecified",
      required: required.includes(name),
      ...(isRecord(property) &&
        Array.isArray(property["enum"]) && { enum: property["enum"] }),
    };
    parameters.push(parameter);
    outline.omittedParameters -= 1;
    if (jsonBytes(outline) >= COMPACT_DESCRIBE_BYTES) {
      parameters.pop();
      outline.omittedParameters += 1;
    }
  }
  return outline;
};

/** One property as a short type: `string`, `object[]`, `"a" | "b"`. */
const typeOutline = (schema: unknown): string => {
  if (!isRecord(schema)) {
    return "any";
  }
  if (Array.isArray(schema["enum"])) {
    return schema["enum"].map((value) => JSON.stringify(value)).join(" | ");
  }
  const type = schema["type"];
  if (type === "array") {
    return `${typeOutline(schema["items"])}[]`;
  }
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    return type.join(" | ");
  }
  const variants = schema["oneOf"] ?? schema["anyOf"];
  if (Array.isArray(variants)) {
    return [...new Set(variants.map(typeOutline))].join(" | ");
  }
  return "any";
};

/** Each parameter's type, required ones marked: what a compact description shows. */
const parameterOutline = (schema: McpJsonSchema): Record<string, string> => {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = new Set(
    Array.isArray(schema["required"]) ? schema["required"] : [],
  );
  return Object.fromEntries(
    Object.entries(properties).map(([key, property]) => [
      key,
      `${typeOutline(property)}${required.has(key) ? " (required)" : ""}`,
    ]),
  );
};

const describeOutline = <Context>(tool: ToolDefinition<Context>) => ({
  id: tool.name,
  description:
    tool.brief === undefined ? tool.summary : `${tool.summary}\n${tool.brief}`,
  access: tool.access,
  destructive: destructiveOf(tool),
  parameters: parameterOutline(tool.inputSchema),
  ...(tool.exampleInput !== undefined && { example: tool.exampleInput }),
  more: 'detail: "full" returns the full input schema.',
});

type DescribeDefinitionOptions<Context> = {
  tool: ToolDefinition<Context>;
  detail: unknown;
  discovery: "bounded" | "outline";
  fullSchema: "input" | "described";
};

const describeDefinition = <Context>({
  tool,
  detail,
  discovery,
  fullSchema,
}: DescribeDefinitionOptions<Context>): ToolOutcome => {
  if (detail !== "full") {
    return jsonSuccess(
      discovery === "outline" ? describeOutline(tool) : describeCompact(tool),
    );
  }
  return jsonSuccess({
    id: tool.name,
    description:
      tool.guide === undefined
        ? tool.summary
        : `${tool.summary}\n${tool.guide}`,
    access: tool.access,
    destructive: destructiveOf(tool),
    ...(discovery === "bounded" && {
      domain: tool.domain ?? tool.name.split(".").at(0),
    }),
    inputSchema:
      fullSchema === "described"
        ? (tool.describedSchema ?? tool.inputSchema)
        : tool.inputSchema,
  });
};

const capabilityListItem = <Context>(
  tool: ToolDefinition<Context>,
  capabilityList: "detailed" | "minimal",
) => {
  const item = {
    id: tool.name,
    summary: tool.summary,
    access: tool.access,
  };
  if (capabilityList === "detailed") {
    return {
      ...item,
      description: null,
      destructive: destructiveOf(tool),
    };
  }
  return { ...item, ...(destructiveOf(tool) && { destructive: true }) };
};

const encodeCursor = (id: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(id)) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const decodeCursor = (cursor: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor) || cursor.length % 4 === 1) {
    return null;
  }
  const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(
    binary,
    (character) => character.codePointAt(0) ?? panic("Empty base64 character."),
  );
  const decoded = new TextDecoder().decode(bytes);
  return decoded.length > 0 && encodeCursor(decoded) === cursor
    ? decoded
    : null;
};

const hasJsonType = (value: unknown, type: string): boolean => {
  if (type === "object") {
    return isRecord(value);
  }
  if (type === "integer") {
    return Number.isInteger(value);
  }
  return typeof value === type;
};

type MetaArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; outcome: ToolOutcome };

/**
 * The capability tools' own arguments, read strictly: a misspelt flag or a
 * string where a boolean belongs would otherwise change what runs.
 */
const readMetaArgs = (
  tool: string,
  schema: {
    properties: Record<string, { type: string; enum?: readonly string[] }>;
    required?: readonly string[];
  },
  value: unknown,
): MetaArgs => {
  if (value !== undefined && !isRecord(value)) {
    return {
      ok: false,
      outcome: validationError(`${tool} takes a JSON object.`, []),
    };
  }
  const args: Record<string, unknown> = {};
  const issues: { path: string; message: string }[] = [];
  for (const [key, entry] of Object.entries(value ?? {})) {
    const property = schema.properties[key];
    if (!Object.hasOwn(schema.properties, key) || property === undefined) {
      issues.push({ path: key, message: `Unknown parameter: ${key}` });
      continue;
    }
    if (entry === null) {
      continue;
    }
    if (
      !hasJsonType(entry, property.type) ||
      (property.enum !== undefined &&
        (typeof entry !== "string" || !property.enum.includes(entry)))
    ) {
      issues.push({
        path: key,
        message: `Expected ${property.enum === undefined ? `a JSON ${property.type}` : property.enum.join(" | ")}.`,
      });
      continue;
    }
    args[key] = entry;
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined && !issues.some(({ path }) => path === key)) {
      issues.push({ path: key, message: `Missing parameter: ${key}` });
    }
  }
  return issues.length > 0
    ? {
        ok: false,
        outcome: validationError(
          `${tool} arguments need clarification.`,
          issues,
          `Accepted parameters: ${Object.keys(schema.properties).join(", ")}.`,
        ),
      }
    : { ok: true, args };
};

type ObserveFailureOptions = {
  onError: ToolFailureObserver | undefined;
  cause: unknown;
  event: ToolFailureEvent;
};

const observeFailure = ({
  onError,
  cause,
  event,
}: ObserveFailureOptions): undefined =>
  // A failing telemetry callback must not expose its own exception on the wire.
  Result.try(() => onError?.(cause, event)).unwrapOr(undefined);

type RunToolOptions<Context> = {
  tool: ToolDefinition<Context>;
  value: unknown;
  context: Context;
  invocation?: "direct" | "capability";
  validateOnly?: boolean;
  onError: ToolFailureObserver | undefined;
  capabilityResult?: "wrapped" | "payload";
  validationResult?: "receipt" | "input";
};

const runTool = async <Context>({
  tool,
  value,
  context,
  invocation = "direct",
  validateOnly = false,
  onError,
  capabilityResult = "wrapped",
  validationResult = "receipt",
}: RunToolOptions<Context>): Promise<ToolCallResult> => {
  const read = readToolInput({
    schema: tool.inputSchema,
    value,
    access: tool.access,
    exactProperties: tool.exactProperties ?? [],
  });
  if (!read.ok) {
    return toCallResult(validationError(read.message, read.issues, read.hint));
  }
  if (validateOnly) {
    return toCallResult(
      jsonSuccess(
        validationResult === "input"
          ? { valid: true, input: read.value }
          : { result: { status: "arguments_read", capability: tool.name } },
      ),
      read.notes,
    );
  }
  const execution = await Result.tryPromise({
    try: async () => tool.run(read.value, context),
    catch: (cause) => {
      observeFailure({
        onError,
        cause,
        event: { tool: tool.name, phase: "handler" },
      });
      return failure({
        code: KIT_ERROR_CODES.internal,
        message: KIT_INTERNAL_MESSAGE,
      });
    },
  });
  const outcome = execution.isOk() ? execution.value : execution.error;
  return toCallResult(
    outcome.ok && invocation === "capability" && capabilityResult === "wrapped"
      ? success({ result: outcome.value })
      : outcome,
    read.notes,
    (cause) =>
      observeFailure({
        onError,
        cause,
        event: { tool: tool.name, phase: "serialization" },
      }),
  );
};

const compareCapabilityNames = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const buildRegistry = <Context>(tools: readonly ToolDefinition<Context>[]) => {
  const byName = new Map<string, ToolDefinition<Context>>();
  const reserved = new Set<string>(Object.values(CAPABILITY_TOOL_NAMES));
  for (const tool of tools) {
    for (const metadata of [
      tool.inputSchema,
      tool.describedSchema ?? null,
      tool.exampleInput ?? null,
    ]) {
      if (!jsonSuccess(metadata).ok) {
        panic(
          "Tool schema and example metadata must contain acyclic JSON data.",
        );
      }
    }
    assertToolInputSchema(tool.inputSchema);
    if (tool.name.length === 0) {
      panic("Tool names must not be empty.");
    }
    if (new TextEncoder().encode(tool.name).length > 128) {
      panic("Tool names must fit in 128 UTF-8 bytes.");
    }
    if (byName.has(tool.name) || reserved.has(tool.name)) {
      panic(`Tool name ${tool.name} is taken.`);
    }
    byName.set(tool.name, tool);
  }
  return byName;
};

/** Build a surface over `tools`. Names must be unique and not a capability tool's. */
export const createToolSurface = <Context>({
  tools,
  onError,
  discovery = { type: "bounded" },
  fullSchema = "input",
  capabilityResult = "wrapped",
  validationResult = "receipt",
  capabilityList = "detailed",
  metaDescriptions = "fixed",
}: ToolSurfaceOptions<Context>): ToolSurface<Context> => {
  const byName = buildRegistry(tools);
  const lazy = tools
    .filter((tool) => tool.direct === undefined)
    .toSorted((a, b) => compareCapabilityNames(a.name, b.name));
  const names = [...byName.keys()];

  const unknownCapability = (id: string): ToolOutcome =>
    failure({
      code: KIT_ERROR_CODES.notFound,
      message: `No capability with id "${id}".`,
      hint: `${didYouMean(closestNames(id, names))}Call ${CAPABILITY_TOOL_NAMES.list} to browse the ids.`,
    });

  const listCapabilities = (value: unknown): ToolOutcome => {
    const read = readMetaArgs(CAPABILITY_TOOL_NAMES.list, LIST_SCHEMA, value);
    if (!read.ok) {
      return read.outcome;
    }
    const {
      domain,
      access = "all",
      cursor,
      limit = DEFAULT_LIST_LIMIT,
    } = read.args;
    if (typeof limit !== "number" || limit < 1 || limit > MAX_LIST_LIMIT) {
      return validationError("limit is out of range.", [
        { path: "limit", message: `Expected 1 to ${MAX_LIST_LIMIT}.` },
      ]);
    }
    const after = typeof cursor === "string" ? decodeCursor(cursor) : undefined;
    if (after === null) {
      return validationError(
        "cursor is not a nextCursor from list_capabilities.",
        [{ path: "cursor", message: "Unrecognised cursor." }],
      );
    }
    const matching = lazy.filter(
      (tool) =>
        (domain === undefined || tool.domain === domain) &&
        (access === "all" || tool.access === access) &&
        (after === undefined || compareCapabilityNames(tool.name, after) > 0),
    );
    const page = matching.slice(0, limit);
    const last = page.at(-1);
    return jsonSuccess({
      ...(capabilityList === "detailed" && { limit }),
      items: page.map((tool) => capabilityListItem(tool, capabilityList)),
      nextCursor:
        last !== undefined && matching.length > page.length
          ? encodeCursor(last.name)
          : null,
    });
  };

  const describeCapability = (value: unknown): ToolOutcome => {
    const read = readMetaArgs(
      CAPABILITY_TOOL_NAMES.describe,
      DESCRIBE_SCHEMA,
      value,
    );
    if (!read.ok) {
      return read.outcome;
    }
    const id = String(read.args["capability"]);
    const tool = byName.get(id);
    if (tool === undefined) {
      return unknownCapability(id);
    }
    return describeDefinition({
      tool,
      detail: read.args["detail"],
      discovery: discovery.type,
      fullSchema,
    });
  };

  const invokeCapability = async (
    value: unknown,
    context: Context,
  ): Promise<ToolCallResult> => {
    const read = readMetaArgs(
      CAPABILITY_TOOL_NAMES.invoke,
      INVOKE_SCHEMA,
      value,
    );
    if (!read.ok) {
      return toCallResult(read.outcome);
    }
    const id = String(read.args["capability"]);
    const tool = byName.get(id);
    if (tool === undefined) {
      return toCallResult(unknownCapability(id));
    }
    return await runTool({
      tool,
      value: read.args["input"] ?? {},
      context,
      invocation: "capability",
      capabilityResult,
      validationResult,
      onError,
      validateOnly: read.args["validate_only"] === true,
    });
  };

  const listTools = (): ListedTool[] => {
    const listed: ListedTool[] = tools.flatMap((tool) =>
      tool.direct === undefined
        ? []
        : [
            {
              name: tool.name,
              description: tool.summary,
              inputSchema: listedSchema(tool.direct.inputSchema),
              annotations: {
                readOnlyHint: tool.access === "read",
                destructiveHint: destructiveOf(tool),
                openWorldHint: false,
              },
            },
          ],
    );
    if (lazy.length === 0) {
      return listed;
    }
    return [
      ...listed,
      {
        name: CAPABILITY_TOOL_NAMES.list,
        description:
          metaDescriptions === "enumerated"
            ? `List tools not shown here (${lazy.map(({ name }) => name).join(", ")}).`
            : "Browse capabilities by domain and access, with pagination.",
        inputSchema: listedSchema(LIST_SCHEMA),
        annotations: READ_ONLY,
      },
      {
        name: CAPABILITY_TOOL_NAMES.describe,
        description:
          metaDescriptions === "enumerated"
            ? 'Parameters, guidance and an example for any tool, by id; detail: "full" for the whole schema.'
            : 'Compact parameters and an invocation skeleton; detail="full" returns the full schema.',
        inputSchema: listedSchema(DESCRIBE_SCHEMA),
        annotations: READ_ONLY,
      },
      {
        name: CAPABILITY_TOOL_NAMES.invoke,
        description: "Run a tool by id with its arguments as `input`.",
        inputSchema: listedSchema(INVOKE_SCHEMA),
        annotations: {
          readOnlyHint: false,
          destructiveHint: lazy.some(destructiveOf),
          openWorldHint: false,
        },
      },
    ];
  };

  const callTool = async (
    name: string,
    args: unknown,
    context: Context,
  ): Promise<ToolCallResult> => {
    switch (name) {
      case CAPABILITY_TOOL_NAMES.list:
        return toCallResult(listCapabilities(args));
      case CAPABILITY_TOOL_NAMES.describe:
        return toCallResult(describeCapability(args));
      case CAPABILITY_TOOL_NAMES.invoke:
        return await invokeCapability(args, context);
      default: {
        const tool = byName.get(name);
        if (tool !== undefined) {
          return await runTool({ tool, value: args, context, onError });
        }
        return toCallResult(
          failure({
            code: KIT_ERROR_CODES.unknownTool,
            message: `Unknown tool "${name}".`,
            hint: `${didYouMean(closestNames(name, names))}Call ${CAPABILITY_TOOL_NAMES.list} to browse the rest.`,
          }),
        );
      }
    }
  };

  return { listTools, callTool };
};
