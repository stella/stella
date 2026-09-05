import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
/**
 * Agent-orientation eval: given stella's agent-facing surface, does a model
 * pick the right tool/command and arguments for a natural-language task,
 * without executing anything?
 *
 * Each task is one user request that carries concrete ids in its context
 * (a workspace, a template, a matter, a contact, a document). Two surfaces
 * are checked:
 *
 *   mcp   The model sees the exact wire tools a real MCP client gets
 *         (`listStaticMcpToolDefinitions("default")` projected through
 *         `toMcpTools`) and the server's connect-time instructions
 *         (`getMcpInstructions("default")`) as its system prompt. The run
 *         ends at the first tool call (`maxIterations(1)`); no tool
 *         executes.
 *   cli   The model sees the generated agent skill
 *         (`packages/cli/skills/stella-cli/SKILL.md`) as its system prompt
 *         and answers with exactly one shell command in a fenced code
 *         block (or explains why the CLI cannot do it).
 *
 * Scoring is deterministic, never a judge model:
 *
 *   outcome    pass / wrong-tool (wrong tool or command path) / bad-args
 *              (schema-invalid or task-relevant argument mismatch) /
 *              missing-confirm (a destructive call omitted the confirm
 *              flag) / declined (the model correctly said the surface
 *              cannot do this) / no-call (no tool call and no command) /
 *              error (the provider run errored)
 *   toolOrCommand  the MCP tool name, or the CLI command path, chosen
 *   argsCheck  "valibot" (validated against the tool's own input schema)
 *              or "structural" (the six legacy MCP tools with no
 *              `inputSchemaSource`: required keys, JSON type, enum
 *              membership only)
 *   latencyMs
 *
 * Usage (from apps/api):
 *   bun run eval:agent-orientation
 *   bun run eval:agent-orientation -- --models gpt-5.6-luna --surface mcp
 *   bun run eval:agent-orientation -- --task delete-contact --json out.json
 */
import { EventType, chat, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyClientTool, TokenUsage } from "@tanstack/ai";
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { resolveCaching } from "@/api/lib/ai-config";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { getMcpInstructions } from "@/api/mcp/instructions";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import type {
  McpToolDefinition,
  McpToolInputSchema,
} from "@/api/mcp/tool-types";

import {
  RESERVED_FLAGS,
  TOOL_ANNOTATIONS,
} from "../../../packages/cli/src/annotations";
import { parseCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-load";
import { uploadCommand } from "../../../packages/cli/src/commands/upload";
import { buildCliRouteTree } from "../../../packages/cli/src/generate-capability-tree";
import { kebabCase } from "../../../packages/cli/src/generate-route-map";
import type {
  RegistryToolListing,
  RouteNode,
} from "../../../packages/cli/src/route-types";
import { runEvalModelTurn } from "./lib/model-turn";

// A bare id resolves through whichever configured provider rates it (GPT
// models may come from OpenAI or OpenRouter); Claude ids are pinned to
// Anthropic so a non-Anthropic default provider cannot claim them.
const DEFAULT_MODELS = ["gpt-5.6-luna", "anthropic::claude-sonnet-5"];
const DEFAULT_RUNS = 1;
// Every run is a paid request; keep a typo from turning into a bill.
const MAX_RUNS = 20;
const MAX_OUTPUT_TOKENS = 1000;
const MODEL_REQUEST_TIMEOUT_MS = 60_000;

const SURFACES = ["mcp", "cli", "both"] as const;
type SurfaceFilter = (typeof SURFACES)[number];
type Surface = Exclude<SurfaceFilter, "both">;

const isSurfaceFilter = (value: string): value is SurfaceFilter =>
  (SURFACES as readonly string[]).includes(value);

const SKILL_PATH = path.join(
  import.meta.dir,
  "../../../packages/cli/skills/stella-cli/SKILL.md",
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// --- CLI schema (for scoring, not the model's system prompt) -------------

// The SAME generated route tree the shipped CLI dispatches against: the
// committed registry snapshot + capability catalog, run through the CLI's
// own `buildCliRouteTree`. Scoring a parsed command against this (instead of
// only the task's hand-picked expected flags) catches unknown flags, wrong
// casing, and required flags a task forgot to assert on.
const REGISTRY_SNAPSHOT_PATH = path.join(
  import.meta.dir,
  "../../../packages/cli/src/generated/registry-snapshot.json",
);
const CAPABILITY_CATALOG_PATH = path.join(
  import.meta.dir,
  "../../../packages/cli/capability-catalog.json",
);

/**
 * Project raw JSON into `RegistryToolListing[]`, guard by guard (no cast):
 * the snapshot is committed, trusted data, but its shape still comes from
 * `unknown` JSON, not a validated domain value. Mirrors
 * `loadBakedListings` in `packages/cli/src/registry-refresh.ts`.
 */
const parseRegistryListings = (raw: unknown): RegistryToolListing[] => {
  if (!Array.isArray(raw)) {
    return panic(
      "agent-orientation eval: registry-snapshot.json is not an array",
    );
  }
  const listings: RegistryToolListing[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = entry["name"];
    const description = entry["description"];
    const inputSchema = entry["inputSchema"];
    if (typeof name === "string" && isRecord(inputSchema)) {
      listings.push({
        name,
        description: typeof description === "string" ? description : "",
        inputSchema,
      });
    }
  }
  return listings;
};

const buildCliSchemaTree = (): RouteNode => {
  const listings = parseRegistryListings(
    JSON.parse(readFileSync(REGISTRY_SNAPSHOT_PATH, "utf-8")),
  );
  const catalogRaw: unknown = JSON.parse(
    readFileSync(CAPABILITY_CATALOG_PATH, "utf-8"),
  );
  const entries = parseCapabilityCatalog(catalogRaw);
  if (entries === null) {
    return panic(
      "agent-orientation eval: capability-catalog.json failed parseCapabilityCatalog",
    );
  }
  return buildCliRouteTree({
    listings,
    annotations: TOOL_ANNOTATIONS,
    entries,
  }).tree;
};

const CLI_SCHEMA_TREE = buildCliSchemaTree();

/** Global flags stricli accepts on every command, bare names (no leading dash). */
const GLOBAL_FLAG_NAMES: ReadonlySet<string> = new Set(
  [...RESERVED_FLAGS].map((flag) => flag.replace(/^-+/u, "")),
);

/** Route-tree lookup for `commandPath`, or `null` when it doesn't resolve to a node. */
const walkRouteNode = (
  tree: RouteNode,
  commandPath: readonly string[],
): RouteNode | null => {
  let node: RouteNode = tree;
  for (const segment of commandPath) {
    if (node.kind !== "route") {
      return null;
    }
    const child = node.children[segment];
    if (child === undefined) {
      return null;
    }
    node = child;
  }
  return node;
};

type LeafFlagSpec = { flag: string; required: boolean };

// `stella upload` is hand-wired outside the generated route tree
// (registered directly in build-cli-tree.ts), so it never reaches
// `buildCliRouteTree`. Its flags are read from the real shipped command
// definition instead of a hand-copied mirror, so this cannot drift from it.
const uploadFlagSpecs = (): readonly LeafFlagSpec[] =>
  Object.entries(uploadCommand.parameters.flags ?? {}).map(([prop, spec]) => ({
    flag: kebabCase(prop),
    required: spec.optional !== true,
  }));

/** The known flags (name + required) for a resolved command path, or `null`. */
const leafFlagSpecsForPath = (
  commandPath: readonly string[],
): readonly LeafFlagSpec[] | null => {
  if (commandPath.at(0) === "upload") {
    return uploadFlagSpecs();
  }
  const node = walkRouteNode(CLI_SCHEMA_TREE, commandPath);
  if (node === null || node.kind === "route") {
    return null;
  }
  return node.spec.flags.map((spec) => ({
    flag: spec.flag.replace(/^--/u, ""),
    required: spec.required,
  }));
};

const CLI_INSTRUCTION =
  "Answer with exactly one shell command in a single fenced code block " +
  "(```sh ... ```) and nothing else. If no command in the skill above can " +
  "do this, do not invent one: reply with one short sentence explaining " +
  "why, and no code block.";

const MCP_SYSTEM_PROMPT = getMcpInstructions("default");

// --- arg checking -----------------------------------------------------------

type ValibotBackedToolDefinition = McpToolDefinition & {
  inputSchemaSource: v.GenericSchema;
};

// The six legacy tools (list_templates, fill_template, save_filled_template,
// list_capabilities, describe_capability, invoke_capability) carry no
// `inputSchemaSource`; every other tool is defined through
// `defineValibotMcpTool`, so this presence check is exactly the registry's
// own legacy/derived split (mirrors MCP_LEGACY_MANUAL_INPUT_SCHEMA_TOOL_NAMES
// in static-tool-definitions.ts, which is not exported).
const hasValibotSchema = (
  definition: McpToolDefinition,
): definition is ValibotBackedToolDefinition =>
  "inputSchemaSource" in definition;

const matchesJsonType = (value: unknown, jsonType: string): boolean => {
  switch (jsonType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
};

type SchemaCheckResult = {
  kind: "valibot" | "structural";
  ok: boolean;
  issues: string[];
};

/** Light structural check for a legacy tool's plain JSON Schema. */
const structuralCheck = (
  schema: McpToolInputSchema,
  args: unknown,
): SchemaCheckResult => {
  if (!isRecord(args)) {
    return {
      kind: "structural",
      ok: false,
      issues: ["input is not an object"],
    };
  }
  const required = Array.isArray(schema["required"])
    ? schema["required"].filter((key): key is string => typeof key === "string")
    : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const issues: string[] = [];
  for (const key of required) {
    if (!(key in args)) {
      issues.push(`missing required "${key}"`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!isRecord(propSchema)) {
      continue;
    }
    const expectedType = propSchema["type"];
    if (
      typeof expectedType === "string" &&
      !matchesJsonType(value, expectedType)
    ) {
      issues.push(
        `"${key}" expected type ${expectedType}, got ${typeof value}`,
      );
    }
    const enumValues = propSchema["enum"];
    if (Array.isArray(enumValues) && !enumValues.includes(value)) {
      issues.push(`"${key}" not in enum`);
    }
  }
  return { kind: "structural", ok: issues.length === 0, issues };
};

const schemaCheck = (
  definition: McpToolDefinition,
  args: unknown,
): SchemaCheckResult => {
  if (hasValibotSchema(definition)) {
    const parsed = v.safeParse(definition.inputSchemaSource, args);
    return {
      kind: "valibot",
      ok: parsed.success,
      issues: parsed.success
        ? []
        : parsed.issues.map(
            (issue) =>
              `${issue.path?.map((p) => String(p.key)).join(".") ?? "<root>"}: ${issue.message}`,
          ),
    };
  }
  return structuralCheck(definition.inputSchema, args);
};

// --- MCP task specs ----------------------------------------------------------

type McpTaskSpec = {
  toolName: string;
  destructive?: true;
  /** Task-specific field checks beyond schema validity; empty = ok. */
  checkArgs: (args: Record<string, unknown>) => string[];
};

const field = (
  args: Record<string, unknown>,
  key: string,
  expected: unknown,
): string[] =>
  args[key] === expected
    ? []
    : [
        `${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(args[key])}`,
      ];

const nested = (
  args: Record<string, unknown>,
  keyPath: readonly string[],
): unknown => {
  let current: unknown = args;
  for (const key of keyPath) {
    current = isRecord(current) ? current[key] : undefined;
  }
  return current;
};

const nestedField = (
  args: Record<string, unknown>,
  keyPath: readonly string[],
  expected: unknown,
): string[] => {
  const value = nested(args, keyPath);
  return value === expected
    ? []
    : [
        `${keyPath.join(".")}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
      ];
};

// --- CLI task specs -----------------------------------------------------------

type CliExpectedCommand = {
  kind: "command";
  /** Tokens after `stella`, e.g. ["document", "list"] or ["capability", "entities", "translate"]. */
  path: readonly string[];
  flags: Readonly<Record<string, string>>;
  destructive?: true;
};

type CliExpectedDeclined = { kind: "declined" };

type CliTaskSpec = CliExpectedCommand | CliExpectedDeclined;

type Task = {
  id: string;
  request: string;
  /**
   * Overrides `request` on the CLI surface, for a task whose two surfaces
   * take genuinely different inputs (the MCP file-reference tools vs. the
   * CLI's local-path `stella upload`). Absent for every other task, where
   * both surfaces see the same prompt.
   */
  cliRequest?: string;
  mcp: McpTaskSpec;
  cli: CliTaskSpec;
};

const TASKS: readonly Task[] = [
  {
    id: "list-workspace-documents",
    request:
      "List every document and folder in workspace ws_acme_2024, the top level.",
    mcp: {
      toolName: "list_documents",
      checkArgs: (args) => field(args, "workspace_id", "ws_acme_2024"),
    },
    cli: {
      kind: "command",
      path: ["document", "list"],
      flags: { "workspace-id": "ws_acme_2024" },
    },
  },
  {
    id: "search-case-law",
    request:
      "Search the case-law corpus for decisions about breach of a duty of care in negligence, restricted to German courts.",
    mcp: {
      toolName: "search_case_law",
      checkArgs: (args) => [
        ...(typeof args["query"] === "string" && args["query"].length > 0
          ? []
          : ["query: expected a non-empty string"]),
        ...field(args, "country", "DE"),
      ],
    },
    cli: {
      kind: "command",
      path: ["case-law", "search"],
      flags: { country: "DE" },
    },
  },
  {
    id: "fill-template",
    request:
      'Fill template tpl_nda_v3 with values {"party_name": "Beta s.r.o.", "effective_date": "2026-09-02"}.',
    mcp: {
      toolName: "fill_template",
      checkArgs: (args) => [
        ...field(args, "template_id", "tpl_nda_v3"),
        ...(isRecord(args["values"]) ? [] : ["values: expected an object"]),
      ],
    },
    cli: {
      kind: "command",
      path: ["template", "fill"],
      flags: { "template-id": "tpl_nda_v3" },
    },
  },
  {
    id: "run-playbook",
    request: "Run playbook pb_diligence_v2 over workspace ws_diligence_17.",
    mcp: {
      toolName: "run_playbook",
      checkArgs: (args) => [
        ...field(args, "workspace_id", "ws_diligence_17"),
        ...field(args, "playbook_id", "pb_diligence_v2"),
      ],
    },
    cli: {
      kind: "command",
      path: ["playbook", "run"],
      flags: {
        "workspace-id": "ws_diligence_17",
        "playbook-id": "pb_diligence_v2",
      },
    },
  },
  {
    id: "delete-contact",
    request:
      "The user has confirmed: delete contact ct_88 from the address book.",
    mcp: {
      toolName: "delete_contact",
      destructive: true,
      checkArgs: (args) => field(args, "contact_id", "ct_88"),
    },
    cli: {
      kind: "command",
      path: ["contact", "delete"],
      flags: { "contact-id": "ct_88" },
      destructive: true,
    },
  },
  {
    id: "translate-document",
    request:
      "Start a DeepL translation to German of document " +
      "ent_7f7f7f7f-1111-2222-3333-444444444444, file field " +
      "fld_5e5e5e5e-1111-2222-3333-444444444444, in workspace ws_acme_2024.",
    mcp: {
      toolName: "invoke_capability",
      checkArgs: (args) => [
        ...field(args, "capability", "document-translations.runs.create"),
        ...nestedField(
          args,
          ["input", "params", "workspaceId"],
          "ws_acme_2024",
        ),
        ...nestedField(
          args,
          ["input", "body", "entityId"],
          "7f7f7f7f-1111-2222-3333-444444444444",
        ),
        ...nestedField(
          args,
          ["input", "body", "fieldId"],
          "5e5e5e5e-1111-2222-3333-444444444444",
        ),
        ...nestedField(args, ["input", "body", "targetLang"], "de"),
        ...nestedField(args, ["input", "body", "engine"], "deepl"),
        ...nestedField(args, ["input", "body", "output"], "translated"),
      ],
    },
    cli: {
      kind: "command",
      path: ["capability", "document-translations", "runs-create"],
      // The run body is reachable only through `--input`; the scorer reads
      // each expected value from that payload, so a reply that names the
      // command but omits the body fails here as it would at the CLI.
      flags: {
        workspace: "ws_acme_2024",
        "entity-id": "7f7f7f7f-1111-2222-3333-444444444444",
        "field-id": "5e5e5e5e-1111-2222-3333-444444444444",
        "target-lang": "de",
        engine: "deepl",
        output: "translated",
      },
    },
  },
  {
    id: "start-workflow-extraction",
    request: "Start the extraction workflow in workspace ws_acme_2024.",
    mcp: {
      toolName: "invoke_capability",
      checkArgs: (args) => [
        ...field(args, "capability", "workspaces.workflow-start"),
        ...nestedField(
          args,
          ["input", "params", "workspaceId"],
          "ws_acme_2024",
        ),
      ],
    },
    cli: {
      kind: "command",
      path: ["capability", "workspaces", "workflow-start"],
      flags: { workspace: "ws_acme_2024" },
    },
  },
  {
    id: "search-across-matters",
    request:
      "Search across every accessible matter for 'force majeure clause'.",
    mcp: {
      toolName: "search_across_matters",
      checkArgs: (args) => field(args, "query", "force majeure clause"),
    },
    cli: {
      kind: "command",
      path: ["search", "matters"],
      flags: { query: "force majeure clause" },
    },
  },
  {
    id: "upload-document-version",
    // The host attached the file, so the direct upload tool applies; the
    // picker is only for hosts that cannot pass a file reference.
    request:
      "The host attached contract-v2.docx (file_id file_9f2, download_url " +
      "https://files.example.test/9f2, mime_type application/vnd.openxmlformats-" +
      "officedocument.wordprocessingml.document). Upload it as a new version of " +
      "document doc_42.",
    // The CLI has no host-file-reference concept: `stella upload` is a
    // hand-wired local-bytes command (packages/cli/src/commands/upload.ts,
    // registered outside the generated route tree) that reads a path off
    // disk, so its prompt gives a local path instead of the MCP surface's
    // file_id/download_url reference.
    cliRequest:
      "The file to upload is at ./contract-v2.docx, in matter ws_acme_2024. " +
      "Upload it as a new version of document doc_42.",
    mcp: {
      toolName: "upload_document_version",
      checkArgs: (args) => [
        ...field(args, "entity_id", "doc_42"),
        ...(args["file"] === undefined ? ["file: expected a value"] : []),
      ],
    },
    cli: {
      kind: "command",
      path: ["upload"],
      flags: {
        file: "./contract-v2.docx",
        "workspace-id": "ws_acme_2024",
        "entity-id": "doc_42",
      },
    },
  },
] as const;

// --- CLI options --------------------------------------------------------------

type CliOptions = {
  models: string[];
  runs: number;
  taskFilter: string | null;
  surface: SurfaceFilter;
  jsonPath: string | null;
};

const parseRuns = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return DEFAULT_RUNS;
  }
  return Math.min(MAX_RUNS, parsed);
};

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    models: DEFAULT_MODELS,
    runs: DEFAULT_RUNS,
    taskFilter: null,
    surface: "both",
    jsonPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv.at(index);
    const value = argv.at(index + 1);
    if (flag === undefined || value === undefined) {
      continue;
    }
    switch (flag) {
      case "--models":
        options.models = value.split(",").map((id) => id.trim());
        index += 1;
        break;
      case "--runs":
        options.runs = parseRuns(value);
        index += 1;
        break;
      case "--task":
        options.taskFilter = value;
        index += 1;
        break;
      case "--surface":
        if (isSurfaceFilter(value)) {
          options.surface = value;
        }
        index += 1;
        break;
      case "--json":
        options.jsonPath = value;
        index += 1;
        break;
      default:
        break;
    }
  }
  return options;
};

// --- model turns --------------------------------------------------------------

type ToolCallCapture = { name: string; argumentText: string; input: unknown };

type ModelTurn = {
  call: ToolCallCapture | null;
  error: string | null;
  finalText: string;
  latencyMs: number;
  usage: TokenUsage | null;
};

const runModelTurn = async ({
  model,
  system,
  request,
  tools,
}: {
  model: ResolvedTanStackTextModel;
  system: string;
  request: string;
  tools: AnyClientTool[];
}): Promise<ModelTurn> => {
  const caching = resolveCaching({
    promptCachingEnabled: false,
    role: "chat",
    scopeKey: null,
  });
  let finalText = "";
  const toolNames = new Map<string, string>();
  const argumentTexts = new Map<string, string>();
  const parsedInputs = new Map<string, unknown>();
  const { error, latencyMs, usage } = await runEvalModelTurn({
    timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    chat: (abortController) =>
      chat({
        abortController,
        adapter: model.adapter,
        messages: [{ role: "user", content: request }],
        // The run ends at the first tool call (or at the model's text reply
        // on the CLI surface, which registers no tools at all); nothing
        // executes.
        agentLoopStrategy: maxIterations(1),
        ...systemPromptsPatch({ caching, model, system }),
        modelOptions: mergeGenerationOptions({
          caching,
          model,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          serviceTier: "standard",
          temperature: 0,
        }),
        tools,
      }),
    onChunk: (chunk) => {
      // Exhaustive over ChatStream's real chunk union (`AGUIEvent`, 22
      // members — narrower than the full `EventType` enum, which also
      // declares deprecated/unused values this stream never emits) instead
      // of an if-chain: a renamed or newly added chunk type fails
      // typechecking at the `satisfies never` default instead of being
      // silently ignored, which for THIS eval would misclassify a run as
      // no-call/pass instead of failing loudly.
      //
      // TOOL_CALL_START, TOOL_CALL_END, and CUSTOM carry a plain string
      // literal `type` (not the `EventType` enum member) by design — see
      // `ToolCallStartEvent`/`ToolCallEndEvent`/`CustomEvent` in
      // `@tanstack/ai`'s types — so those three cases match on the literal
      // string instead of the enum member.
      switch (chunk.type) {
        case EventType.TEXT_MESSAGE_CONTENT: {
          finalText += chunk.delta;
          break;
        }
        case EventType.TOOL_CALL_ARGS: {
          argumentTexts.set(
            chunk.toolCallId,
            (argumentTexts.get(chunk.toolCallId) ?? "") + chunk.delta,
          );
          break;
        }
        case "TOOL_CALL_START": {
          toolNames.set(chunk.toolCallId, chunk.toolCallName);
          break;
        }
        case "TOOL_CALL_END": {
          if (chunk.input !== undefined) {
            parsedInputs.set(chunk.toolCallId, chunk.input);
          }
          break;
        }
        // The run-turn helper captures the error message and usage from
        // these; this eval scores neither beyond what it already returns.
        case EventType.RUN_ERROR:
        case EventType.RUN_FINISHED: {
          break;
        }
        // Every other chunk type carries nothing this eval scores on: only
        // the first tool call's name/args/input and the final text/usage/error
        // matter here. Listed explicitly (not folded into an implicit
        // default) so the ignored set is visible in the diff whenever it grows.
        case EventType.TEXT_MESSAGE_START:
        case EventType.TEXT_MESSAGE_END:
        case EventType.TOOL_CALL_RESULT:
        case EventType.STATE_SNAPSHOT:
        case EventType.STATE_DELTA:
        case EventType.MESSAGES_SNAPSHOT:
        case "CUSTOM":
        case EventType.RUN_STARTED:
        case EventType.STEP_STARTED:
        case EventType.STEP_FINISHED:
        case EventType.REASONING_START:
        case EventType.REASONING_MESSAGE_START:
        case EventType.REASONING_MESSAGE_CONTENT:
        case EventType.REASONING_MESSAGE_END:
        case EventType.REASONING_ENCRYPTED_VALUE:
        case EventType.REASONING_END: {
          break;
        }
        default: {
          chunk satisfies never;
          panic(`Unhandled chunk: ${String(chunk)}`);
        }
      }
    },
  });

  const firstCallId = [...argumentTexts.keys(), ...parsedInputs.keys()].at(0);
  if (firstCallId === undefined) {
    return { call: null, error, finalText, latencyMs, usage };
  }
  const name = toolNames.get(firstCallId) ?? "";
  const argumentText = argumentTexts.get(firstCallId) ?? "";
  const input = parsedInputs.get(firstCallId) ?? parseJsonOrNull(argumentText);
  return {
    call: { name, argumentText, input },
    error,
    finalText,
    latencyMs,
    usage,
  };
};

// Boundary decode of model output: malformed JSON is an eval finding, not a
// failure to propagate.
const parseJsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// --- MCP tool registration ------------------------------------------------

/**
 * MCP wire tools carry a plain JSON Schema, not a Standard Schema instance.
 * Wrapping it as a Standard JSON Schema (the same seam
 * `auto-apply-suggest-changes-tools.ts` uses for folio's raw schema) lets
 * TanStack accept it without a runtime `validate`: the provider enforces the
 * JSON Schema, and this eval never executes the call.
 */
const toStandardJsonSchema = (
  jsonSchema: Record<string, unknown>,
): StandardJSONSchemaV1<unknown, unknown> => ({
  "~standard": {
    version: 1,
    vendor: "stella-eval",
    jsonSchema: {
      input: () => jsonSchema,
      output: () => jsonSchema,
    },
  },
});

const buildMcpClientTools = (): AnyClientTool[] => {
  const definitions = listStaticMcpToolDefinitions("default");
  const wireTools = toMcpTools(definitions);
  return wireTools.map((tool) =>
    toolDefinition({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: toStandardJsonSchema(tool.inputSchema),
    }).client(),
  );
};

const mcpDefinitionsByName = new Map(
  listStaticMcpToolDefinitions("default").map((definition) => [
    definition.name,
    definition,
  ]),
);

// --- CLI command parsing --------------------------------------------------

const CODE_FENCE_PATTERN = /```(?:[a-z]*\n)?([\s\S]*?)```/u;

const extractCommand = (text: string): string | null => {
  const fenced = CODE_FENCE_PATTERN.exec(text);
  const candidate = fenced ? fenced[1] : null;
  return candidate === null || candidate === undefined
    ? null
    : (candidate.trim().split("\n").at(0)?.trim() ?? null);
};

/** Quote-aware split: keeps a quoted value (including spaces) as one token. */
const tokenizeCommand = (command: string): string[] => {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
};

type ParsedCliCommand = {
  path: string[];
  flags: Map<string, string | null>;
  /** Whether the reply actually invoked the `stella` executable. */
  startsWithStella: boolean;
};

const parseCliCommand = (command: string): ParsedCliCommand => {
  const tokens = tokenizeCommand(command);
  const startsWithStella = tokens[0] === "stella";
  const commandPath: string[] = [];
  const flags = new Map<string, string | null>();
  let index = startsWithStella ? 1 : 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (token.startsWith("--")) {
      const [flagName, inlineValue] = token.slice(2).split(/[=](.*)/u);
      if (flagName === undefined) {
        index += 1;
        continue;
      }
      if (inlineValue !== undefined) {
        flags.set(flagName, inlineValue);
        index += 1;
        continue;
      }
      const next = tokens[index + 1];
      const takesValue = next !== undefined && !next.startsWith("--");
      flags.set(flagName, takesValue ? next : null);
      index += takesValue ? 2 : 1;
      continue;
    }
    commandPath.push(token);
    index += 1;
  }
  return { path: commandPath, flags, startsWithStella };
};

const DECLINED_PATTERN =
  /\b(?:cannot|can't|no command|not (?:able|possible|supported)|does not support|doesn't support|no CLI|not exposed|unavailable)\b/iu;

const kebabToSnake = (flagName: string): string =>
  flagName.replaceAll("-", "_");

// A capability's `--input` keeps the handler schema's own camelCase keys.
const kebabToCamel = (flagName: string): string =>
  flagName.replaceAll(/-([a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );

// A CLI flag whose value the eval also accepts from the `--input` JSON escape
// hatch under a schema key that differs from the flag's own kebab-cased name
// (`document field set`'s `translate`d body sits under a nested capability
// wrapper; `--workspace` maps to the schema's `workspaceId`, not `workspace`).
const FLAG_INPUT_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  workspace: ["workspaceId", "workspace_id"],
};

/** One level of `--input`'s body/params/query/values wrapper flattened to top. */
const flattenInputPayload = (payload: unknown): Record<string, unknown> => {
  if (!isRecord(payload)) {
    return {};
  }
  const flat: Record<string, unknown> = { ...payload };
  for (const wrapperKey of ["body", "params", "query", "values"]) {
    const wrapper = payload[wrapperKey];
    if (!isRecord(wrapper)) {
      continue;
    }
    for (const [key, value] of Object.entries(wrapper)) {
      if (!(key in flat)) {
        flat[key] = value;
      }
    }
  }
  return flat;
};

/**
 * A flag's value, read from a literal `--flag value` first and, failing
 * that, from a `--input '<json>'` escape-hatch payload (every curated and
 * capability command accepts one per the skill's "Deep payloads" convention).
 * `@file` / `@-` / `-` input forms are not resolvable from the reply alone
 * and fall through to "not found".
 */
const resolveFlagValue = (
  parsed: ParsedCliCommand,
  flagName: string,
): string | null | undefined => {
  const direct = parsed.flags.get(flagName);
  if (direct !== undefined) {
    return direct;
  }
  const inputText = parsed.flags.get("input");
  if (
    inputText === undefined ||
    inputText === null ||
    inputText.startsWith("@") ||
    inputText === "-"
  ) {
    return undefined;
  }
  const flat = flattenInputPayload(parseJsonOrNull(inputText));
  const candidateKeys = [
    kebabToSnake(flagName),
    kebabToCamel(flagName),
    ...(FLAG_INPUT_KEY_ALIASES[flagName] ?? []),
  ];
  for (const key of candidateKeys) {
    const value = flat[key];
    if (value !== undefined) {
      return typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  return undefined;
};

// --- scoring ---------------------------------------------------------------

type Outcome =
  | "pass"
  | "wrong-tool"
  | "bad-args"
  | "missing-confirm"
  | "declined"
  | "no-call"
  | "error";

type RunRecord = {
  modelId: string;
  taskId: string;
  surface: Surface;
  repeat: number;
  outcome: Outcome;
  toolOrCommand: string;
  argsCheck: "valibot" | "structural" | "n/a";
  issues: string[];
  latencyMs: number;
  usage: TokenUsage | null;
  finalText: string;
};

const scoreMcpRun = ({
  task,
  turn,
}: {
  task: Task;
  turn: ModelTurn;
}): {
  outcome: Outcome;
  toolOrCommand: string;
  argsCheck: RunRecord["argsCheck"];
  issues: string[];
} => {
  if (turn.error !== null) {
    return {
      outcome: "error",
      toolOrCommand: "-",
      argsCheck: "n/a",
      issues: [turn.error],
    };
  }
  if (turn.call === null) {
    return {
      outcome: "no-call",
      toolOrCommand: "-",
      argsCheck: "n/a",
      issues: [],
    };
  }
  const { name, input } = turn.call;
  if (name !== task.mcp.toolName) {
    return {
      outcome: "wrong-tool",
      toolOrCommand: name || "<unknown>",
      argsCheck: "n/a",
      issues: [`expected ${task.mcp.toolName}`],
    };
  }
  const args = isRecord(input) ? input : {};
  if (task.mcp.destructive === true && args["confirm"] !== true) {
    return {
      outcome: "missing-confirm",
      toolOrCommand: name,
      argsCheck: "n/a",
      issues: ["confirm: expected true"],
    };
  }
  const definition = mcpDefinitionsByName.get(name);
  const schema =
    definition === undefined
      ? { kind: "structural" as const, ok: false, issues: ["unknown tool"] }
      : schemaCheck(definition, input);
  const taskIssues = isRecord(input)
    ? task.mcp.checkArgs(args)
    : ["input is not an object"];
  const issues = [...schema.issues, ...taskIssues];
  return {
    outcome: issues.length === 0 ? "pass" : "bad-args",
    toolOrCommand: name,
    argsCheck: schema.kind,
    issues,
  };
};

const scoreCliRun = ({
  task,
  turn,
}: {
  task: Task;
  turn: ModelTurn;
}): { outcome: Outcome; toolOrCommand: string; issues: string[] } => {
  if (turn.error !== null) {
    return { outcome: "error", toolOrCommand: "-", issues: [turn.error] };
  }
  const commandLine = extractCommand(turn.finalText);
  if (task.cli.kind === "declined") {
    if (commandLine === null) {
      return DECLINED_PATTERN.test(turn.finalText)
        ? { outcome: "declined", toolOrCommand: "-", issues: [] }
        : { outcome: "no-call", toolOrCommand: "-", issues: [] };
    }
    return {
      outcome: "wrong-tool",
      toolOrCommand: commandLine,
      issues: ["expected no command (CLI cannot do this)"],
    };
  }
  if (commandLine === null) {
    return { outcome: "no-call", toolOrCommand: "-", issues: [] };
  }
  const parsed = parseCliCommand(commandLine);
  if (!parsed.startsWithStella) {
    return {
      outcome: "bad-args",
      toolOrCommand: parsed.path.join(" ") || "<unknown>",
      issues: [
        'expected the command to start with "stella" (the CLI executable)',
      ],
    };
  }
  const expected = task.cli;
  // The command path is the leading tokens; anything after it is a
  // positional argument (the CLI takes none, only `--flags`), so it is a
  // bad-args finding rather than a wrong command.
  const pathMatches = expected.path.every(
    (token, index) => parsed.path[index] === token,
  );
  if (!pathMatches) {
    return {
      outcome: "wrong-tool",
      toolOrCommand: parsed.path.join(" ") || "<unknown>",
      issues: [`expected path "${expected.path.join(" ")}"`],
    };
  }
  const issues: string[] = parsed.path
    .slice(expected.path.length)
    .map((token) => `unexpected positional argument "${token}"`);
  // Validate the FULL command against the generated CLI schema (not just
  // the task's hand-picked expected flags): an unknown flag, wrong casing,
  // or a required flag the task forgot to assert on all surface here.
  const leafFlagSpecs = leafFlagSpecsForPath(expected.path);
  if (leafFlagSpecs !== null) {
    const knownFlagNames = new Set([
      ...leafFlagSpecs.map((spec) => spec.flag),
      ...GLOBAL_FLAG_NAMES,
    ]);
    for (const flagName of parsed.flags.keys()) {
      if (!knownFlagNames.has(flagName)) {
        issues.push(`unknown flag --${flagName}`);
      }
    }
    for (const spec of leafFlagSpecs) {
      if (spec.required && resolveFlagValue(parsed, spec.flag) === undefined) {
        issues.push(`missing required --${spec.flag}`);
      }
    }
  }
  for (const [flagName, expectedValue] of Object.entries(expected.flags)) {
    const actual = resolveFlagValue(parsed, flagName);
    if (actual !== expectedValue) {
      issues.push(
        `--${flagName}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  if (expected.destructive === true && !parsed.flags.has("yes")) {
    return {
      outcome: "missing-confirm",
      toolOrCommand: parsed.path.join(" "),
      issues: ["expected --yes"],
    };
  }
  return {
    outcome: issues.length === 0 ? "pass" : "bad-args",
    toolOrCommand: parsed.path.join(" "),
    issues,
  };
};

// --- run orchestration -------------------------------------------------------

const runMcpTask = async ({
  model,
  modelId,
  task,
  repeat,
  tools,
}: {
  model: ResolvedTanStackTextModel;
  modelId: string;
  task: Task;
  repeat: number;
  tools: AnyClientTool[];
}): Promise<RunRecord> => {
  const turn = await runModelTurn({
    model,
    system: MCP_SYSTEM_PROMPT,
    request: task.request,
    tools,
  });
  const score = scoreMcpRun({ task, turn });
  return {
    modelId,
    taskId: task.id,
    surface: "mcp",
    repeat,
    ...score,
    latencyMs: turn.latencyMs,
    usage: turn.usage,
    finalText: turn.finalText,
  };
};

const runCliTask = async ({
  model,
  modelId,
  task,
  repeat,
  skill,
}: {
  model: ResolvedTanStackTextModel;
  modelId: string;
  task: Task;
  repeat: number;
  skill: string;
}): Promise<RunRecord> => {
  const turn = await runModelTurn({
    model,
    system: `${skill}\n\n${CLI_INSTRUCTION}`,
    request: task.cliRequest ?? task.request,
    tools: [],
  });
  const score = scoreCliRun({ task, turn });
  return {
    modelId,
    taskId: task.id,
    surface: "cli",
    repeat,
    ...score,
    argsCheck: "n/a",
    latencyMs: turn.latencyMs,
    usage: turn.usage,
    finalText: turn.finalText,
  };
};

const countsText = (values: readonly string[]): string => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  const entries = Object.entries(counts);
  return entries.length === 0
    ? "-"
    : entries
        .map(([outcome, count]) =>
          count > 1 ? `${outcome}×${String(count)}` : outcome,
        )
        .join(", ");
};

const renderReport = (runs: readonly RunRecord[]): string => {
  const lines: string[] = [];
  const modelIds = [...new Set(runs.map((run) => run.modelId))];
  for (const modelId of modelIds) {
    const modelRuns = runs.filter((run) => run.modelId === modelId);
    lines.push(`\n### ${modelId}\n`);
    lines.push(
      "| surface | task | run | outcome | tool/command | args | issues | ms |",
      "| --- | --- | ---: | --- | --- | --- | --- | ---: |",
    );
    for (const run of modelRuns) {
      lines.push(
        [
          `| ${run.surface}`,
          run.taskId,
          String(run.repeat),
          run.outcome,
          run.toolOrCommand.replaceAll("|", "\\|"),
          run.argsCheck,
          run.issues.length === 0
            ? "-"
            : run.issues.join("; ").replaceAll("|", "\\|"),
          `${String(run.latencyMs)} |`,
        ].join(" | "),
      );
    }
    const total = modelRuns.length;
    const passed = modelRuns.filter((run) => run.outcome === "pass").length;
    const declined = modelRuns.filter(
      (run) => run.outcome === "declined",
    ).length;
    lines.push(
      "",
      `passed ${String(passed)}/${String(total)}, correctly declined ${String(declined)}, outcomes: ${countsText(
        modelRuns.map((run) => run.outcome),
      )}`,
    );
  }
  return lines.join("\n");
};

const resolveModels = async (
  modelIds: readonly string[],
): Promise<{ id: string; model: ResolvedTanStackTextModel }[]> => {
  const { getTanStackTextModelById, hasTanStackInstanceProvider } =
    await import("@/api/lib/tanstack-ai-models");
  if (!hasTanStackInstanceProvider()) {
    return panic(
      "No instance AI provider is configured; set a provider key in .env",
    );
  }
  return modelIds.map((id) => ({
    id,
    model: getTanStackTextModelById(id, null, {
      role: "chat",
      organizationId: null,
    }),
  }));
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const tasks = TASKS.filter(
    (task) => options.taskFilter === null || task.id === options.taskFilter,
  );
  if (tasks.length === 0) {
    panic(`Unknown task ${String(options.taskFilter)}`);
  }
  const surfaces: Surface[] =
    options.surface === "both" ? ["mcp", "cli"] : [options.surface];
  const models = await resolveModels(options.models);
  const mcpTools = surfaces.includes("mcp") ? buildMcpClientTools() : [];
  const skill = surfaces.includes("cli")
    ? readFileSync(SKILL_PATH, "utf-8")
    : "";

  const runs: RunRecord[] = [];
  for (const { id, model } of models) {
    for (const task of tasks) {
      for (const surface of surfaces) {
        for (let repeat = 1; repeat <= options.runs; repeat += 1) {
          process.stderr.write(
            `${id} · ${surface} · ${task.id} · run ${String(repeat)}\n`,
          );
          const run = await (surface === "mcp"
            ? runMcpTask({ model, modelId: id, task, repeat, tools: mcpTools })
            : runCliTask({ model, modelId: id, task, repeat, skill }));
          runs.push(run);
        }
      }
    }
  }

  process.stdout.write(`${renderReport(runs)}\n`);
  if (options.jsonPath !== null) {
    await writeFile(options.jsonPath, JSON.stringify({ runs }, null, 2));
  }
};

await main();
