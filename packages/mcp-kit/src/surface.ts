/**
 * A tool surface with lazy discovery. The frequent tools are listed directly
 * with compact schemas; the rest stay out of `tools/list` and are reached
 * through three capability tools, so a turn pays only for what is listed:
 *
 * - `list_capabilities` pages the unlisted tools: id, summary, access.
 * - `describe_capability` returns a bounded outline, or the full input schema on request
 *   (listed tools included, whose listed schema is the compact one).
 * - `invoke_capability` runs one by id with `input` checked against that
 *   full schema; `validate_only` checks without running.
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
  success,
  toCallResult,
  validationError,
} from "./envelope";
import { readToolInput } from "./input";
import { compactSchema } from "./schema";
import type {
  JsonSchema,
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

/** Registry used to construct a transport-independent tool surface. */
export type ToolSurfaceOptions<Context> = {
  readonly tools: readonly ToolDefinition<Context>[];
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

const listedSchema = (schema: JsonSchema): ListedTool["inputSchema"] => ({
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
  const outline = {
    id: tool.name,
    description: [...tool.summary].slice(0, 120).join(""),
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

const encodeCursor = (id: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(id)) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
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
      (property.enum !== undefined && !property.enum.includes(String(entry)))
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

type RunToolOptions<Context> = {
  tool: ToolDefinition<Context>;
  value: unknown;
  context: Context;
  invocation?: "direct" | "capability";
  validateOnly?: boolean;
};

const runTool = async <Context>({
  tool,
  value,
  context,
  invocation = "direct",
  validateOnly = false,
}: RunToolOptions<Context>): Promise<ToolCallResult> => {
  const read = readToolInput({
    schema: tool.inputSchema,
    value,
    access: tool.access,
    exactProperties: tool.exactProperties,
  });
  if (!read.ok) {
    return toCallResult(validationError(read.message, read.issues, read.hint));
  }
  if (validateOnly) {
    return toCallResult(
      success({ result: { valid: true, capability: tool.name } }),
      read.notes,
    );
  }
  const execution = await Result.tryPromise({
    try: () => tool.run(read.value, context),
    catch: (error) =>
      failure({
        code: KIT_ERROR_CODES.internal,
        message: error instanceof Error ? error.message : String(error),
      }),
  });
  const outcome = execution.isOk() ? execution.value : execution.error;
  return toCallResult(
    outcome.ok && invocation === "capability"
      ? success({ result: outcome.value })
      : outcome,
    read.notes,
  );
};

const buildRegistry = <Context>(tools: readonly ToolDefinition<Context>[]) => {
  const byName = new Map<string, ToolDefinition<Context>>();
  const reserved = new Set<string>(Object.values(CAPABILITY_TOOL_NAMES));
  for (const tool of tools) {
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
}: ToolSurfaceOptions<Context>): ToolSurface<Context> => {
  const byName = buildRegistry(tools);
  const lazy = tools
    .filter((tool) => tool.direct === undefined)
    .toSorted((a, b) => {
      if (a.name < b.name) {
        return -1;
      }
      return a.name > b.name ? 1 : 0;
    });
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
        (after === undefined || tool.name > after),
    );
    const page = matching.slice(0, limit);
    const last = page.at(-1);
    return success({
      limit,
      items: page.map((tool) => ({
        id: tool.name,
        summary: tool.summary,
        access: tool.access,
        description: tool.guide ?? null,
        destructive: destructiveOf(tool),
      })),
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
    if (read.args["detail"] !== "full") {
      return success(describeCompact(tool));
    }
    return success({
      id: tool.name,
      description:
        tool.guide === undefined
          ? tool.summary
          : `${tool.summary}\n${tool.guide}`,
      access: tool.access,
      destructive: destructiveOf(tool),
      domain: tool.domain ?? tool.name.split(".").at(0),
      inputSchema: tool.inputSchema,
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
          "Browse capabilities by domain and access, with pagination.",
        inputSchema: listedSchema(LIST_SCHEMA),
        annotations: READ_ONLY,
      },
      {
        name: CAPABILITY_TOOL_NAMES.describe,
        description:
          'Compact parameters and an invocation skeleton; detail="full" returns the full schema.',
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
          return await runTool({ tool, value: args, context });
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
