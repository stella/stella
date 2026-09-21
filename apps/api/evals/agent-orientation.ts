import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
/**
 * Agent-orientation eval: given stella's agent-facing surface, does a model
 * pick the right tool/command and arguments for a natural-language task,
 * without executing anything?
 *
 * Each task is one user request that carries concrete ids in its context
 * (a matter, a template, a contact, a document). Two surfaces
 * are checked:
 *
 *   mcp   The model sees the exact wire tools a real MCP client gets
 *         (`listStaticMcpToolDefinitions("default")` plus a fixture of
 *         account skills named through the served precedence step, all
 *         projected through `toMcpTools`) and the server's connect-time
 *         instructions (`getMcpInstructions("default")`) as its system
 *         prompt. The run ends at the first tool call
 *         (`maxIterations(1)`); no tool executes.
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
import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyClientTool, TokenUsage } from "@tanstack/ai";
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { resolveCaching } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import {
  streamChatChunks,
  toolCallEndInputOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { skillToolDefinition, toMcpTools } from "@/api/mcp/gateway/list-tools";
import { resolveSkillToolPrecedence } from "@/api/mcp/gateway/skills";
import type { SkillToolRow } from "@/api/mcp/gateway/skills";
import { normalizeObjectInputAtBoundary } from "@/api/mcp/input-normalization";
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
import { sameCliFlagValue } from "./lib/cli-flag-score";
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

const loadCapabilityCatalog = () => {
  const catalogRaw: unknown = JSON.parse(
    readFileSync(CAPABILITY_CATALOG_PATH, "utf-8"),
  );
  const entries = parseCapabilityCatalog(catalogRaw);
  if (entries === null) {
    return panic(
      "agent-orientation eval: capability-catalog.json failed parseCapabilityCatalog",
    );
  }
  return entries;
};

const CAPABILITY_CATALOG = loadCapabilityCatalog();

const buildCliSchemaTree = (): RouteNode => {
  const listings = parseRegistryListings(
    JSON.parse(readFileSync(REGISTRY_SNAPSHOT_PATH, "utf-8")),
  );
  return buildCliRouteTree({
    listings,
    annotations: TOOL_ANNOTATIONS,
    entries: CAPABILITY_CATALOG,
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
  /**
   * The arguments as the handler receives them, with the lenient readers
   * already applied. A task asserts against these rather than the raw call:
   * dispatch normalizes at the boundary, so an eval scoring the raw spelling
   * would fail a call production accepts, and would stop measuring whether the
   * contract is drivable.
   */
  normalized: unknown;
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
      normalized: args,
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
  return {
    kind: "structural",
    ok: issues.length === 0,
    issues,
    normalized: args,
  };
};

const schemaCheck = (
  definition: McpToolDefinition,
  args: unknown,
): SchemaCheckResult => {
  // The same boundary dispatch runs before the schema, so the eval measures the
  // contract a model actually faces: `CZ` for a country and `1. 10. 2026` for a
  // date are read here exactly as `tools.ts` reads them.
  const boundary = isRecord(args)
    ? normalizeObjectInputAtBoundary({
        exactProperties: ["confirm", "validate_only"],
        schema: definition.inputSchema,
        value: args,
      })
    : null;
  if (boundary !== null && !boundary.ok) {
    return {
      kind: hasValibotSchema(definition) ? "valibot" : "structural",
      ok: false,
      issues: boundary.issues.map(
        ({ path: issuePath, message }) =>
          `${issuePath.length === 0 ? "<root>" : issuePath}: ${message}`,
      ),
      normalized: args,
    };
  }
  const normalized = boundary === null ? args : boundary.value;
  if (hasValibotSchema(definition)) {
    const parsed = v.safeParse(definition.inputSchemaSource, normalized);
    return {
      kind: "valibot",
      ok: parsed.success,
      issues: parsed.success
        ? []
        : parsed.issues.map(
            (issue) =>
              `${issue.path?.map((p) => String(p.key)).join(".") ?? "<root>"}: ${issue.message}`,
          ),
      normalized,
    };
  }
  return structuralCheck(definition.inputSchema, normalized);
};

// --- MCP task specs ----------------------------------------------------------

type McpTaskSpec = {
  toolName: string;
  /**
   * The eval starts after a call that already happened, not at discovery: a
   * read-only capability description, or a compat `search` whose results the
   * model is asked to read.
   */
  preflight?:
    | { type: "capability-described" }
    | { type: "compat-search-returned" };
  /**
   * The tool names this task exposes, for a task about a client that carries
   * fewer tools than the surface has. Absent exposes the whole default
   * surface, which is what every other task measures.
   */
  exposedTools?: readonly string[];
  destructive?: true;
  /**
   * One call that passes: it must parse through the tool's own input schema
   * and satisfy `checkArgs`. Pinned at startup so a schema change (an id
   * that became a UUID, a renamed property) fails the fixture loudly instead
   * of quietly turning every run into a rejection.
   */
  exampleArgs: Record<string, unknown>;
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

/**
 * A set of (eli, anchor) entries as one comparable string: each entry's keys
 * are sorted and the entries themselves are sorted, so a batch naming the
 * same provisions in the other order compares equal.
 */
const provisionEntrySet = (entries: readonly unknown[]): string =>
  JSON.stringify(
    entries
      .map((entry) =>
        isRecord(entry)
          ? JSON.stringify(
              Object.entries(entry).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            )
          : JSON.stringify(entry),
      )
      .sort((left, right) => left.localeCompare(right)),
  );

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
  /**
   * Repeatable flags this task needs more than one of, by minimum count. For a
   * batch command the cardinality IS the contract, and pinning the values
   * would score the model's wording rather than whether it batched.
   */
  repeatedAtLeast?: Readonly<Record<string, number>>;
  /** Tokens after `stella`, e.g. ["document", "list"] or ["capability", "entities", "translate"]. */
  path: readonly string[];
  flags: Readonly<Record<string, string>>;
  /**
   * Compare the `--input` payload's arrays as sets. For a batch tool the
   * entries are a set the tool answers in input order, and nothing in the
   * request fixes which entry comes first.
   */
  unorderedInput?: true;
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

/**
 * Account skills as a real `tools/list` would serve them: the fixture rows go
 * through the served precedence and naming step, so the exposed names
 * (including the collision suffix `risk.review` receives next to
 * `risk_review`) are whatever production would generate, never a hand-typed
 * example. Tasks look their expected name up by slug.
 */
const skillFixtureRow = ({
  description,
  name,
  slug,
}: {
  description: string;
  name: string;
  slug: string;
}): SkillToolRow => ({
  body: `# ${name}\n\nFollow these steps.`,
  compatibility: null,
  description,
  id: toSafeId<"agentSkill">(`skill_${slug}`),
  license: null,
  metadata: {},
  name,
  origin: "authored",
  scope: "team",
  slug,
  userId: "user_eval",
  version: "1.0.0",
});

const SKILL_FIXTURES = resolveSkillToolPrecedence([
  skillFixtureRow({
    slug: "summarize",
    name: "Summarize a document",
    description:
      "Step-by-step instructions for producing a client-ready summary of a contract or decision.",
  }),
  skillFixtureRow({
    slug: "risk_review",
    name: "Risk review (English-law leases)",
    description:
      "Checklist for reviewing the risk allocation in an English-law commercial lease.",
  }),
  skillFixtureRow({
    slug: "risk.review",
    name: "Risk review (Czech commercial contracts)",
    description:
      "Checklist for reviewing risk clauses in a Czech commercial contract (obchodní smlouva).",
  }),
]);

const skillToolNameOf = (slug: string): string =>
  SKILL_FIXTURES.find((skill) => skill.slug === slug)?.exposedName ??
  panic(`agent-orientation eval: no skill fixture with slug ${slug}`);

// Fixture ids are shaped like the ids a real list or search result returns:
// every id input on the MCP surface is validated as a UUID, so a placeholder
// such as `ct_88` would only measure whether a model refuses to guess.
const ACME_MATTER_ID = "a1a1a1a1-0000-4000-8000-000000000001";
const DILIGENCE_MATTER_ID = "a1a1a1a1-0000-4000-8000-000000000017";
const NDA_TEMPLATE_ID = "7e7e7e7e-0000-4000-8000-000000000003";
const DILIGENCE_PLAYBOOK_ID = "9b9b9b9b-0000-4000-8000-000000000002";
const CONTACT_ID = "c0c0c0c0-0000-4000-8000-000000000088";
const DOCUMENT_ID = "d0d0d0d0-0000-4000-8000-000000000042";
const TRANSLATION_ENTITY_ID = "7f7f7f7f-1111-4222-8333-444444444444";
const TRANSLATION_FIELD_ID = "5e5e5e5e-1111-4222-8333-444444444444";
const CASE_LAW_DECISION_ID = "b2b2b2b2-0000-4000-8000-000000000031";
const CASE_LAW_SECOND_DECISION_ID = "b2b2b2b2-0000-4000-8000-000000000032";
// A published Czech docket, the way a brief cites one. Not UUID-shaped and not
// guessable, so the task carries it the way a citation in a document would.
const CASE_LAW_DOCKET = "Pl. ÚS 33/97";
// A legislation work is addressed by its ELI, and its provisions by the
// publisher's own anchors; neither is UUID-shaped, and neither is guessable,
// so the tasks carry them the way a previous call would have returned them.
const STATUTE_ELI = "/eli/cz/sb/2012/89";
/** The quoted query the corpus-search task asks for, verbatim on both surfaces. */
const CZECH_DAMAGES_QUERY = "náhrada škody";
const STATUTE_ANCHOR = "par_1729";
const STATUTE_SECOND_ANCHOR = "par_2079";

const TASKS: readonly Task[] = [
  {
    id: "list-matter-documents",
    request: `List every document and folder in matter ${ACME_MATTER_ID}, the top level.`,
    mcp: {
      toolName: "list_documents",
      exampleArgs: { matter_id: ACME_MATTER_ID },
      checkArgs: (args) => field(args, "matter_id", ACME_MATTER_ID),
    },
    cli: {
      kind: "command",
      path: ["document", "list"],
      flags: { "matter-id": ACME_MATTER_ID },
    },
  },
  {
    id: "search-case-law",
    // The corpus admits alpha-3 codes only, and the tool's `country` input
    // now names the admitted ones, so the task asks for a jurisdiction the
    // corpus carries: a task naming one it does not measures a guess rather
    // than orientation.
    request:
      "Search the Czech case-law corpus for decisions about breach of a duty of care in negligence. Try a couple of phrasings in the same call.",
    mcp: {
      toolName: "search_case_law",
      exampleArgs: {
        queries: ["breach of duty of care negligence", "negligent breach"],
        country: "CZE",
      },
      checkArgs: (args) => {
        const queries = args["queries"];
        return [
          // At least two: one phrasing is a valid call, but this task asks for
          // several in one call, and a single query would pass a batch task
          // the model did not perform. The wording is the model's own.
          ...(Array.isArray(queries) &&
          queries.length >= 2 &&
          queries.every(
            (query) => typeof query === "string" && query.length > 0,
          )
            ? []
            : [
                `queries: expected at least 2 non-empty strings, got ${JSON.stringify(queries)}`,
              ]),
          // The handler folds the code to upper case (publicCaseLawCountry),
          // so `cze` is as correct as `CZE`.
          ...(typeof args["country"] === "string" &&
          args["country"].toUpperCase() === "CZE"
            ? []
            : [
                `country: expected CZE, got ${JSON.stringify(args["country"])}`,
              ]),
        ];
      },
    },
    cli: {
      kind: "command",
      path: ["case-law", "search"],
      flags: { country: "CZE" },
      // `--queries` repeats; the task is about carrying several, not about
      // which words, so the expectation is the count and nothing else.
      repeatedAtLeast: { queries: 2 },
    },
  },
  {
    id: "lookup-case-law",
    request: `A brief cites ${CASE_LAW_DOCKET}. Find that decision in the Czech corpus so I can open it.`,
    mcp: {
      toolName: "lookup_case_law",
      exampleArgs: { country: "CZE", identifiers: [CASE_LAW_DOCKET] },
      checkArgs: (args) => {
        const identifiers = args["identifiers"];
        if (!Array.isArray(identifiers)) {
          return ["identifiers: expected an array"];
        }
        return [
          // The docket is the whole point: a paraphrase is a text search, and
          // search_case_law is the tool for that.
          ...(identifiers.length === 1 && identifiers.at(0) === CASE_LAW_DOCKET
            ? []
            : [
                `identifiers: expected [${JSON.stringify(CASE_LAW_DOCKET)}], got ${JSON.stringify(identifiers)}`,
              ]),
          ...(typeof args["country"] === "string" &&
          args["country"].toUpperCase() === "CZE"
            ? []
            : [
                `country: expected CZE, got ${JSON.stringify(args["country"])}`,
              ]),
        ];
      },
    },
    cli: {
      kind: "command",
      path: ["case-law", "lookup"],
      flags: { country: "CZE", identifiers: CASE_LAW_DOCKET },
    },
  },
  {
    id: "search-case-law-czech-country-spelling",
    // Asked in Czech, a model writes the country the way Czech writes it:
    // `CZ`, `Česko`, `Česká republika`. The corpus keys on `CZE`, so while the
    // input was capped at three characters those calls were rejected at the
    // schema and the model answered from memory instead of from the corpus.
    // The request is in Czech because that is the condition that produces the
    // spelling; the assertion is on the country the reader resolves.
    request:
      "Najdi českou judikaturu k promlčení práva na náhradu škody ze " +
      "smlouvy. Zkus v jednom volání několik formulací dotazu.",
    // The CLI surface scores a constructed command line, which no boundary
    // reader sees, so its country is named here: the spelling is the MCP
    // half's subject and command construction is this half's.
    cliRequest:
      "Najdi českou judikaturu (country code CZE) k promlčení práva na " +
      "náhradu škody ze smlouvy. Zkus v jednom volání několik formulací.",
    mcp: {
      toolName: "search_case_law",
      exampleArgs: {
        queries: ["promlčení náhrady škody", "promlčecí lhůta náhrada škody"],
        country: "CZ",
      },
      checkArgs: (args) => {
        const queries = args["queries"];
        return [
          ...(Array.isArray(queries) &&
          queries.length >= 2 &&
          queries.every(
            (query) => typeof query === "string" && query.length > 0,
          )
            ? []
            : [
                `queries: expected at least 2 non-empty strings, got ${JSON.stringify(queries)}`,
              ]),
          // The country reader canonicalizes at the boundary this eval parses
          // through, so every spelling that names Czechia arrives as `CZE`.
          ...(args["country"] === "CZE"
            ? []
            : [
                `country: expected CZE after normalization, got ${JSON.stringify(args["country"])}`,
              ]),
        ];
      },
    },
    cli: {
      kind: "command",
      path: ["case-law", "search"],
      flags: { country: "CZE" },
      repeatedAtLeast: { queries: 2 },
    },
  },
  {
    id: "compat-search-case-law",
    // An OpenAI-compatible client outside developer mode carries `search` and
    // `fetch` and nothing else, so this task exposes those two alone. What it
    // measures is whether a model handed only that pair reaches for the corpus
    // at all, rather than answering a case-law question from memory.
    request:
      "Find Czech case law on the limitation period for a claim for damages.",
    mcp: {
      toolName: "search",
      exposedTools: ["search", "fetch"],
      exampleArgs: { query: `promlčení ${CZECH_DAMAGES_QUERY}` },
      checkArgs: (args) => {
        const query = args["query"];
        // The wording is the model's own; a corpus search it did not make is
        // what this task is looking for.
        return typeof query === "string" && query.trim().length > 0
          ? []
          : [
              `query: expected a non-empty string, got ${JSON.stringify(query)}`,
            ];
      },
    },
    // The CLI excludes this pair deliberately: it has named corpus commands,
    // so there is no leaf for a client that only drives `search`.
    cli: { kind: "declined" },
  },
  {
    id: "compat-fetch-decision",
    // The second call of the same client's loop. `search` has already
    // answered, so what is measured is whether the model passes the id it was
    // handed back verbatim rather than re-spelling it as a bare UUID or a
    // docket number.
    request: "Read the decision that search returned.",
    mcp: {
      toolName: "fetch",
      exposedTools: ["search", "fetch"],
      preflight: { type: "compat-search-returned" },
      exampleArgs: { id: `decision:${CASE_LAW_DECISION_ID}` },
      checkArgs: (args) =>
        field(args, "id", `decision:${CASE_LAW_DECISION_ID}`),
    },
    cli: { kind: "declined" },
  },
  {
    id: "read-case-law-decisions",
    request: `Give me the text of decisions ${CASE_LAW_DECISION_ID} and ${CASE_LAW_SECOND_DECISION_ID}. Fetch both in a single call.`,
    mcp: {
      toolName: "read_case_law_decision",
      exampleArgs: {
        decision_ids: [CASE_LAW_DECISION_ID, CASE_LAW_SECOND_DECISION_ID],
      },
      checkArgs: (args) => {
        const ids = args["decision_ids"];
        if (!Array.isArray(ids)) {
          return ["decision_ids: expected an array"];
        }
        // Both decisions in one call is the contract this tool exists for;
        // two single-id calls would each cost a round trip.
        if (ids.length !== 2) {
          return [`decision_ids: expected 2 entries, got ${ids.length}`];
        }
        return [CASE_LAW_DECISION_ID, CASE_LAW_SECOND_DECISION_ID].flatMap(
          (expected, index) =>
            ids[index] === expected
              ? []
              : [
                  `decision_ids.${index}: expected ${expected}, got ${JSON.stringify(ids[index])}`,
                ],
        );
      },
    },
    cli: {
      kind: "command",
      path: ["case-law", "read"],
      // Both ids, in order: a command naming one of the two is not the batch
      // workflow this task measures.
      flags: {
        "decision-ids": JSON.stringify([
          CASE_LAW_DECISION_ID,
          CASE_LAW_SECOND_DECISION_ID,
        ]),
      },
    },
  },
  {
    id: "search-czech-legislation",
    request: `Search the stella legislation corpus for Czech statutes about "${CZECH_DAMAGES_QUERY}". Restrict the results to Czechia.`,
    mcp: {
      toolName: "search_legislation",
      exampleArgs: { country: "CZE", query: CZECH_DAMAGES_QUERY },
      checkArgs: (args) => [
        // The request quotes the query, so a paraphrase is a different search.
        ...field(args, "query", CZECH_DAMAGES_QUERY),
        // The handler folds the code (publicLegislationCountry), so `cze` is
        // as correct as `CZE`.
        ...(typeof args["country"] === "string" &&
        args["country"].toUpperCase() === "CZE"
          ? []
          : [`country: expected CZE, got ${JSON.stringify(args["country"])}`]),
      ],
    },
    cli: {
      kind: "command",
      path: ["legislation", "search"],
      flags: { country: "CZE", query: CZECH_DAMAGES_QUERY },
    },
  },
  {
    id: "read-statute-as-of",
    request: `I need the consolidated text of the act with ELI ${STATUTE_ELI} as it stood on 1 March 2016, not the current one.`,
    mcp: {
      toolName: "read_statute",
      exampleArgs: { as_of: "2016-03-01", eli: STATUTE_ELI },
      checkArgs: (args) => [
        ...field(args, "eli", STATUTE_ELI),
        // The whole point of the task: without as_of the tool answers with
        // today's consolidation, which is not what was asked.
        ...field(args, "as_of", "2016-03-01"),
      ],
    },
    cli: {
      kind: "command",
      path: ["legislation", "read"],
      flags: { eli: STATUTE_ELI, "as-of": "2016-03-01" },
    },
  },
  {
    id: "read-statute-provisions",
    request: `From the act with ELI ${STATUTE_ELI}, give me the wording of the provisions at anchors ${STATUTE_ANCHOR} and ${STATUTE_SECOND_ANCHOR}. Fetch both in a single call.`,
    mcp: {
      toolName: "read_statute_provisions",
      exampleArgs: {
        items: [
          { anchor: STATUTE_ANCHOR, eli: STATUTE_ELI },
          { anchor: STATUTE_SECOND_ANCHOR, eli: STATUTE_ELI },
        ],
      },
      checkArgs: (args) => {
        const items = args["items"];
        if (!Array.isArray(items)) {
          return ["items: expected an array"];
        }
        // Both provisions in one call is the contract this tool exists for;
        // two single-item calls would each cost a round trip.
        if (items.length !== 2) {
          return [`items: expected 2 entries, got ${items.length}`];
        }
        // The batch is a set, not a sequence: the request names two
        // provisions without fixing which comes first, so either order is
        // right.
        const requested = provisionEntrySet([
          { anchor: STATUTE_ANCHOR, eli: STATUTE_ELI },
          { anchor: STATUTE_SECOND_ANCHOR, eli: STATUTE_ELI },
        ]);
        const supplied = provisionEntrySet(items);
        return supplied === requested
          ? []
          : [`items: expected ${requested}, got ${supplied}`];
      },
    },
    cli: {
      kind: "command",
      path: ["legislation", "provisions"],
      // The batch is reachable only through `--input`; the scorer compares
      // the parsed payload as a set, so neither key order nor entry order
      // matters.
      unorderedInput: true,
      flags: {
        input: JSON.stringify({
          items: [
            { anchor: STATUTE_ANCHOR, eli: STATUTE_ELI },
            { anchor: STATUTE_SECOND_ANCHOR, eli: STATUTE_ELI },
          ],
        }),
      },
    },
  },
  {
    id: "read-provision-history",
    request: `How has the provision at anchor ${STATUTE_ANCHOR} of ${STATUTE_ELI} been amended over time? I want its wording in each consolidation.`,
    mcp: {
      toolName: "read_provision_history",
      exampleArgs: { anchor: STATUTE_ANCHOR, eli: STATUTE_ELI },
      checkArgs: (args) => [
        ...field(args, "eli", STATUTE_ELI),
        ...field(args, "anchor", STATUTE_ANCHOR),
      ],
    },
    cli: {
      kind: "command",
      path: ["legislation", "history"],
      flags: { anchor: STATUTE_ANCHOR, eli: STATUTE_ELI },
    },
  },
  {
    id: "read-case-law-citations",
    request: `Decision ${CASE_LAW_DECISION_ID} is the one I want to rely on. Find out what the courts that have cited it since actually said about it.`,
    mcp: {
      toolName: "read_case_law_citations",
      exampleArgs: {
        decision_id: CASE_LAW_DECISION_ID,
        direction: "cited_by",
      },
      checkArgs: (args) => [
        ...field(args, "decision_id", CASE_LAW_DECISION_ID),
        // The whole point of the task: the other direction answers what this
        // decision cites, which is not what was asked.
        ...field(args, "direction", "cited_by"),
      ],
    },
    cli: {
      kind: "command",
      path: ["case-law", "citations"],
      flags: { "decision-id": CASE_LAW_DECISION_ID, direction: "cited_by" },
    },
  },
  {
    id: "fill-template",
    request: `Fill template ${NDA_TEMPLATE_ID} with values {"party_name": "Beta s.r.o.", "effective_date": "2026-09-02"}.`,
    mcp: {
      toolName: "fill_template",
      exampleArgs: {
        template_id: NDA_TEMPLATE_ID,
        values: { party_name: "Beta s.r.o.", effective_date: "2026-09-02" },
      },
      checkArgs: (args) => [
        ...field(args, "template_id", NDA_TEMPLATE_ID),
        ...(isRecord(args["values"]) ? [] : ["values: expected an object"]),
      ],
    },
    cli: {
      kind: "command",
      path: ["template", "fill"],
      flags: { "template-id": NDA_TEMPLATE_ID },
    },
  },
  {
    id: "preview-template-conditions",
    request: `Preview template ${NDA_TEMPLATE_ID}'s AI-decided conditions with values {"party_name": "Beta s.r.o.", "is_consumer": false} without filling it.`,
    mcp: {
      toolName: "preview_template_conditions",
      exampleArgs: {
        template_id: NDA_TEMPLATE_ID,
        values: { party_name: "Beta s.r.o.", is_consumer: false },
      },
      checkArgs: (args) => [
        ...field(args, "template_id", NDA_TEMPLATE_ID),
        ...(isRecord(args["values"])
          ? [
              ...field(args["values"], "party_name", "Beta s.r.o."),
              ...field(args["values"], "is_consumer", false),
            ]
          : ["values: expected an object"]),
      ],
    },
    cli: {
      kind: "command",
      path: ["template", "preview-conditions"],
      flags: {
        "template-id": NDA_TEMPLATE_ID,
        input: JSON.stringify({
          values: { party_name: "Beta s.r.o.", is_consumer: false },
        }),
      },
    },
  },
  {
    id: "run-playbook",
    request: `Run playbook ${DILIGENCE_PLAYBOOK_ID} over matter ${DILIGENCE_MATTER_ID}.`,
    mcp: {
      toolName: "run_playbook",
      exampleArgs: {
        matter_id: DILIGENCE_MATTER_ID,
        playbook_id: DILIGENCE_PLAYBOOK_ID,
      },
      checkArgs: (args) => [
        ...field(args, "matter_id", DILIGENCE_MATTER_ID),
        ...field(args, "playbook_id", DILIGENCE_PLAYBOOK_ID),
      ],
    },
    cli: {
      kind: "command",
      path: ["playbook", "run"],
      flags: {
        "matter-id": DILIGENCE_MATTER_ID,
        "playbook-id": DILIGENCE_PLAYBOOK_ID,
      },
    },
  },
  {
    id: "delete-contact",
    request: `The user has confirmed: delete contact ${CONTACT_ID} from the address book.`,
    mcp: {
      toolName: "delete_contact",
      destructive: true,
      exampleArgs: { contact_id: CONTACT_ID, confirm: true },
      checkArgs: (args) => field(args, "contact_id", CONTACT_ID),
    },
    cli: {
      kind: "command",
      path: ["contact", "delete"],
      flags: { "contact-id": CONTACT_ID },
      destructive: true,
    },
  },
  // The capability tasks name the capability id: without it, every model
  // starts with list_capabilities, a legitimate discovery step this
  // first-call scorer cannot credit.
  {
    id: "translate-document",
    request:
      `Start a DeepL translation to German through the document-translations.runs.create capability: document ${TRANSLATION_ENTITY_ID}, ` +
      `file field ${TRANSLATION_FIELD_ID}, in matter ${ACME_MATTER_ID}.`,
    mcp: {
      toolName: "invoke_capability",
      exampleArgs: {
        capability: "document-translations.runs.create",
        input: {
          params: { matterId: ACME_MATTER_ID },
          body: {
            entityId: TRANSLATION_ENTITY_ID,
            fieldId: TRANSLATION_FIELD_ID,
            targetLang: "de",
            engine: "deepl",
            output: "translated",
          },
        },
      },
      checkArgs: (args) => [
        ...field(args, "capability", "document-translations.runs.create"),
        ...nestedField(args, ["input", "params", "matterId"], ACME_MATTER_ID),
        ...nestedField(
          args,
          ["input", "body", "entityId"],
          TRANSLATION_ENTITY_ID,
        ),
        ...nestedField(
          args,
          ["input", "body", "fieldId"],
          TRANSLATION_FIELD_ID,
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
        "matter-id": ACME_MATTER_ID,
        "entity-id": TRANSLATION_ENTITY_ID,
        "field-id": TRANSLATION_FIELD_ID,
        "target-lang": "de",
        engine: "deepl",
        output: "translated",
      },
    },
  },
  {
    id: "compare-document-versions",
    request:
      "Redline these two versions of document 22222222-2222-4222-8222-222222222222: " +
      "compare version 44444444-4444-4444-8444-444444444444 with the version before it. " +
      "Keep the tracked changes that are already in the older version, accept the ones in " +
      "the newer version, and save the redline as a new version of the document.",
    mcp: {
      toolName: "compare_documents",
      exampleArgs: {
        source: {
          type: "previous",
          document_id: "22222222-2222-4222-8222-222222222222",
          target_version_id: "44444444-4444-4444-8444-444444444444",
        },
        base_tracked_changes: "keep",
        target_tracked_changes: "accept",
        output_mode: "version",
      },
      checkArgs: (args) => [
        ...nestedField(args, ["source", "type"], "previous"),
        ...nestedField(
          args,
          ["source", "document_id"],
          "22222222-2222-4222-8222-222222222222",
        ),
        ...nestedField(
          args,
          ["source", "target_version_id"],
          "44444444-4444-4444-8444-444444444444",
        ),
        ...field(args, "base_tracked_changes", "keep"),
        ...field(args, "target_tracked_changes", "accept"),
        ...field(args, "output_mode", "version"),
      ],
    },
    cli: {
      kind: "command",
      path: ["document", "compare"],
      // `source` is a discriminated object, so the leaf carries it through
      // `--input` and takes the scalar dispositions as flags.
      flags: {
        "base-tracked-changes": "keep",
        "target-tracked-changes": "accept",
        "output-mode": "version",
        input:
          '{"source":{"type":"previous","document_id":"22222222-2222-4222-8222-222222222222","target_version_id":"44444444-4444-4444-8444-444444444444"}}',
      },
    },
  },
  {
    id: "prepare-file-comparison",
    request:
      "I've attached two Word files, Draft.docx (18342 bytes, sha256 " +
      "3f1a2b4c5d6e7f809a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071) and " +
      "Revised.docx (19004 bytes, sha256 " +
      "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0). " +
      "Redline them for me. They are not saved in stella.",
    mcp: {
      toolName: "prepare_file_comparison",
      exampleArgs: {
        base: {
          name: "Draft.docx",
          size: 18_342,
          sha256_hex:
            "3f1a2b4c5d6e7f809a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071",
        },
        target: {
          name: "Revised.docx",
          size: 19_004,
          sha256_hex:
            "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
        },
      },
      checkArgs: (args) => [
        ...nestedField(args, ["base", "name"], "Draft.docx"),
        ...nestedField(args, ["base", "size"], 18_342),
        ...nestedField(
          args,
          ["base", "sha256_hex"],
          "3f1a2b4c5d6e7f809a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071",
        ),
        ...nestedField(args, ["target", "name"], "Revised.docx"),
        ...nestedField(args, ["target", "size"], 19_004),
        ...nestedField(
          args,
          ["target", "sha256_hex"],
          "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
        ),
      ],
    },
    cli: {
      kind: "command",
      path: ["document", "comparison", "prepare"],
      flags: {
        input:
          '{"base":{"name":"Draft.docx","size":18342,"sha256_hex":"3f1a2b4c5d6e7f809a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071"},"target":{"name":"Revised.docx","size":19004,"sha256_hex":"9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0"}}',
      },
    },
  },
  {
    id: "open-file-comparison",
    // A chat host gives the model no way to move bytes: the right call is the
    // panel, not prepare_file_comparison with sizes and checksums it cannot
    // know, and not a claim that it uploaded the attachments itself.
    request:
      "I've attached two Word files, the original NDA and the counterparty's " +
      "markup. They are not in stella. Redline them for me.",
    mcp: {
      toolName: "open_file_comparison",
      exampleArgs: {},
      checkArgs: () => [],
    },
    // The CLI reads local files itself and stages them through the prepare
    // command; the panel is a host view it has no channel for.
    cli: { kind: "declined" },
  },
  {
    id: "prepare-file-comparison-from-links",
    request:
      "Redline these two contracts for me; they are not in stella. Original: " +
      "https://files.example.com/nda/original.docx, revised: " +
      "https://files.example.com/nda/revised.docx.",
    mcp: {
      toolName: "prepare_file_comparison_from_links",
      exampleArgs: {
        base: { url: "https://files.example.com/nda/original.docx" },
        target: { url: "https://files.example.com/nda/revised.docx" },
      },
      checkArgs: (args) => [
        ...nestedField(
          args,
          ["base", "url"],
          "https://files.example.com/nda/original.docx",
        ),
        ...nestedField(
          args,
          ["target", "url"],
          "https://files.example.com/nda/revised.docx",
        ),
      ],
    },
    cli: {
      kind: "command",
      path: ["document", "comparison", "prepare-from-links"],
      flags: {
        input:
          '{"base":{"url":"https://files.example.com/nda/original.docx"},"target":{"url":"https://files.example.com/nda/revised.docx"}}',
      },
    },
  },
  {
    id: "compare-staged-uploads",
    // The second half of the same workflow: the model is handed the `next`
    // payload prepare_file_comparison returned and has to copy it back rather
    // than compose a source of its own.
    request:
      "Both files are uploaded. prepare_file_comparison returned " +
      '{"tool":"compare_documents","source":{"type":"uploads",' +
      '"base_upload_id":"77777777-7777-4777-8777-777777777777",' +
      '"target_upload_id":"88888888-8888-4888-8888-888888888888"}}. ' +
      "Accept the tracked changes already in both files and give me the " +
      "redline to download.",
    mcp: {
      toolName: "compare_documents",
      exampleArgs: {
        source: {
          type: "uploads",
          base_upload_id: "77777777-7777-4777-8777-777777777777",
          target_upload_id: "88888888-8888-4888-8888-888888888888",
        },
        base_tracked_changes: "accept",
        target_tracked_changes: "accept",
        output_mode: "download",
      },
      checkArgs: (args) => [
        ...nestedField(args, ["source", "type"], "uploads"),
        ...nestedField(
          args,
          ["source", "base_upload_id"],
          "77777777-7777-4777-8777-777777777777",
        ),
        ...nestedField(
          args,
          ["source", "target_upload_id"],
          "88888888-8888-4888-8888-888888888888",
        ),
        ...field(args, "base_tracked_changes", "accept"),
        ...field(args, "target_tracked_changes", "accept"),
        ...field(args, "output_mode", "download"),
      ],
    },
    cli: {
      kind: "command",
      path: ["document", "compare"],
      flags: {
        "base-tracked-changes": "accept",
        "target-tracked-changes": "accept",
        "output-mode": "download",
        input:
          '{"source":{"type":"uploads","base_upload_id":"77777777-7777-4777-8777-777777777777","target_upload_id":"88888888-8888-4888-8888-888888888888"}}',
      },
    },
  },
  {
    id: "start-workflow-extraction",
    request: `Start the extraction workflow in matter ${ACME_MATTER_ID} through the matters.workflow-start capability.`,
    mcp: {
      toolName: "invoke_capability",
      exampleArgs: {
        capability: "matters.workflow-start",
        input: { params: { matterId: ACME_MATTER_ID } },
      },
      checkArgs: (args) => [
        ...field(args, "capability", "matters.workflow-start"),
        ...nestedField(args, ["input", "params", "matterId"], ACME_MATTER_ID),
      ],
    },
    cli: {
      kind: "command",
      path: ["capability", "matters", "workflow-start"],
      flags: { "matter-id": ACME_MATTER_ID },
    },
  },
  {
    id: "search-across-matters",
    request:
      "Search across every accessible matter for 'force majeure clause'.",
    mcp: {
      toolName: "search_across_matters",
      exampleArgs: { query: "force majeure clause" },
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
      `document ${DOCUMENT_ID}.`,
    // The CLI has no host-file-reference concept: `stella upload` is a
    // hand-wired local-bytes command (packages/cli/src/commands/upload.ts,
    // registered outside the generated route tree) that reads a path off
    // disk, so its prompt gives a local path instead of the MCP surface's
    // file_id/download_url reference.
    cliRequest:
      `The file to upload is at ./contract-v2.docx, in matter ${ACME_MATTER_ID}. ` +
      `Upload it as a new version of document ${DOCUMENT_ID}.`,
    mcp: {
      toolName: "upload_document_version",
      exampleArgs: {
        entity_id: DOCUMENT_ID,
        file: {
          file_id: "file_9f2",
          download_url: "https://files.example.test/9f2",
          mime_type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      },
      checkArgs: (args) => [
        ...field(args, "entity_id", DOCUMENT_ID),
        ...(args["file"] === undefined ? ["file: expected a value"] : []),
      ],
    },
    cli: {
      kind: "command",
      path: ["upload"],
      flags: {
        file: "./contract-v2.docx",
        "matter-id": ACME_MATTER_ID,
        "entity-id": DOCUMENT_ID,
      },
    },
  },
  // Skill tools are account-specific, argument-less reads of stored
  // instructions; the CLI has no skill surface, so it must decline.
  {
    id: "skill-instructions",
    request: `Before you summarize the share purchase agreement in matter ${ACME_MATTER_ID}, load the stella skill instructions for summarizing a document.`,
    mcp: {
      toolName: skillToolNameOf("summarize"),
      exampleArgs: {},
      checkArgs: () => [],
    },
    cli: { kind: "declined" },
  },
  {
    id: "skill-instructions-suffixed",
    request:
      "Load the stella skill instructions for reviewing risk clauses in a Czech commercial contract (obchodní smlouva), then wait for my next message.",
    mcp: {
      toolName: skillToolNameOf("risk.review"),
      exampleArgs: {},
      checkArgs: () => [],
    },
    cli: { kind: "declined" },
  },
] as const;

/**
 * A fixture is only evidence when the call it expects can pass: each task's
 * `exampleArgs` must parse through the target tool's own input schema and
 * satisfy the task's checks. Runs before any paid request.
 */
const assertMcpTaskFixtures = (tasks: readonly Task[]): void => {
  const failures: string[] = [];
  for (const task of tasks) {
    const definition = mcpDefinitionsByName.get(task.mcp.toolName);
    if (definition === undefined) {
      failures.push(`${task.id}: unknown tool ${task.mcp.toolName}`);
      continue;
    }
    const unknownExposed = (task.mcp.exposedTools ?? []).filter(
      (name) => !mcpDefinitionsByName.has(name),
    );
    if (unknownExposed.length > 0) {
      failures.push(
        `${task.id}: unknown exposed tools ${unknownExposed.join(", ")}`,
      );
    }
    const schema = schemaCheck(definition, task.mcp.exampleArgs);
    const issues = [
      ...schema.issues,
      ...task.mcp.checkArgs(
        isRecord(schema.normalized) ? schema.normalized : task.mcp.exampleArgs,
      ),
    ];
    if (issues.length > 0) {
      failures.push(`${task.id}: ${issues.join("; ")}`);
    }
  }
  if (failures.length > 0) {
    panic(
      `agent-orientation eval: task fixtures no longer pass their own tool contracts\n${failures.join("\n")}`,
    );
  }
};

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
      streamChatChunks({
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
          const input = toolCallEndInputOf(chunk);
          if (input !== undefined) {
            parsedInputs.set(chunk.toolCallId, input);
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

const listMcpSurfaceDefinitions = (): McpToolDefinition[] => [
  ...listStaticMcpToolDefinitions("default"),
  ...SKILL_FIXTURES.map(skillToolDefinition),
];

const buildMcpClientTools = (
  exposed?: ReadonlySet<string>,
): AnyClientTool[] => {
  const wireTools = toMcpTools(listMcpSurfaceDefinitions()).filter(
    (tool) => exposed === undefined || exposed.has(tool.name),
  );
  return wireTools.map((tool) =>
    toolDefinition({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: toStandardJsonSchema(tool.inputSchema),
    }).client(),
  );
};

const mcpDefinitionsByName = new Map(
  listMcpSurfaceDefinitions().map((definition) => [
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
  /**
   * Every value a repeatable flag carried, in order. `flags` keeps the last
   * one, which is what a single-valued expectation compares; a batch command
   * is only proved by the whole list, so a reply naming one of two requested
   * ids cannot pass as the batch workflow.
   */
  repeatedFlags: Map<string, string[]>;
  /** Whether the reply actually invoked the `stella` executable. */
  startsWithStella: boolean;
};

const parseCliCommand = (command: string): ParsedCliCommand => {
  const tokens = tokenizeCommand(command);
  const startsWithStella = tokens[0] === "stella";
  const commandPath: string[] = [];
  const flags = new Map<string, string | null>();
  const repeatedFlags = new Map<string, string[]>();
  const record = (flagName: string, value: string | null): void => {
    flags.set(flagName, value);
    if (value !== null) {
      repeatedFlags.set(flagName, [
        ...(repeatedFlags.get(flagName) ?? []),
        value,
      ]);
    }
  };
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
        record(flagName, inlineValue);
        index += 1;
        continue;
      }
      const next = tokens[index + 1];
      const takesValue = next !== undefined && !next.startsWith("--");
      record(flagName, takesValue ? next : null);
      index += takesValue ? 2 : 1;
      continue;
    }
    commandPath.push(token);
    index += 1;
  }
  return { path: commandPath, flags, repeatedFlags, startsWithStella };
};

// Models spell a refusal with a typographic apostrophe (`can’t`) as often as
// a straight one, and "no such command exists" as often as "no command".
const DECLINED_PATTERN =
  /\b(?:cannot|can[’']t|no (?:such )?command|not (?:able|possible|supported)|does not (?:support|exist)|doesn[’']t (?:support|exist)|no CLI|not exposed|unavailable)\b/iu;

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
// wrapper; `--matter-id` maps to the schema's `matterId`, not `matter_id`).
const FLAG_INPUT_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "matter-id": ["matterId", "matter_id"],
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

/**
 * Every value a repeatable flag carried: the repeats a command spelled out, or
 * the array its `--input` payload put under the same key. An expectation
 * written as a JSON array compares against this rather than against the last
 * repeat.
 */
const resolveFlagValues = (
  parsed: ParsedCliCommand,
  flagName: string,
): string[] | undefined => {
  const repeats = parsed.repeatedFlags.get(flagName);
  if (repeats !== undefined) {
    return repeats;
  }
  const fromInput = resolveFlagValue(parsed, flagName);
  if (typeof fromInput !== "string") {
    return undefined;
  }
  const parsedInput: unknown = parseJsonOrNull(fromInput);
  return Array.isArray(parsedInput) &&
    parsedInput.every((entry) => typeof entry === "string")
    ? parsedInput
    : undefined;
};

/** An expectation spelled as a JSON array of strings, or null when it is not. */
const expectedFlagValues = (expectedValue: string): string[] | null => {
  const parsedValue: unknown = parseJsonOrNull(expectedValue);
  return Array.isArray(parsedValue) &&
    parsedValue.every((entry) => typeof entry === "string")
    ? parsedValue
    : null;
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

type WorkflowScope = "first-call" | "post-discovery-first-call";

type RunRecord = {
  modelId: string;
  taskId: string;
  surface: Surface;
  workflowScope: WorkflowScope;
  repeat: number;
  outcome: Outcome;
  toolOrCommand: string;
  argsCheck: "valibot" | "structural" | "n/a";
  issues: string[];
  latencyMs: number;
  usage: TokenUsage | null;
  finalText: string;
  /** Synthetic calls only; retain rejected payloads for contract diagnosis. */
  call?: ModelTurn["call"];
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
      ? {
          kind: "structural" as const,
          ok: false,
          issues: ["unknown tool"],
          normalized: input,
        }
      : schemaCheck(definition, input);
  const checked = isRecord(schema.normalized) ? schema.normalized : args;
  const taskIssues = isRecord(input)
    ? task.mcp.checkArgs(checked)
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
  for (const [flagName, minimum] of Object.entries(
    expected.repeatedAtLeast ?? {},
  )) {
    const carried = resolveFlagValues(parsed, flagName)?.length ?? 0;
    if (carried < minimum) {
      issues.push(
        `--${flagName}: expected at least ${String(minimum)} values, got ${String(carried)}`,
      );
    }
  }
  for (const [flagName, expectedValue] of Object.entries(expected.flags)) {
    const expectedList = expectedFlagValues(expectedValue);
    if (expectedList !== null) {
      const actualList = resolveFlagValues(parsed, flagName);
      if (
        actualList === undefined ||
        actualList.length !== expectedList.length ||
        actualList.some((value, index) => value !== expectedList[index])
      ) {
        issues.push(
          `--${flagName}: expected ${JSON.stringify(expectedList)}, got ${JSON.stringify(actualList)}`,
        );
      }
      continue;
    }
    const actual = resolveFlagValue(parsed, flagName);
    if (
      !sameCliFlagValue({
        actual,
        expected: expectedValue,
        flagName,
        unordered: expected.unorderedInput === true,
      })
    ) {
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

const COMPAT_SEARCH_PREFLIGHT = [
  "Eval scope: post-search first-call authoring. A `search` call has already run and returned this result. Do not call `search` again; make the one `fetch` call that reads the decision it names. This eval captures the call but never executes it.",
  JSON.stringify({
    results: [
      {
        id: `decision:${CASE_LAW_DECISION_ID}`,
        title: "Nejvyssi soud 25 Cdo 1234/2020",
        url: "https://stll.app/law/cze/cases/nejvyssi-soud/25-cdo-1234-2020",
      },
    ],
    nextCursor: null,
  }),
].join("\n");

const mcpPreflightContext = (task: Task): string => {
  if (task.mcp.preflight?.type === "compat-search-returned") {
    return COMPAT_SEARCH_PREFLIGHT;
  }
  if (task.mcp.preflight?.type !== "capability-described") {
    return "";
  }
  const capabilityId = task.mcp.exampleArgs["capability"];
  if (typeof capabilityId !== "string") {
    return panic(
      `agent-orientation eval: ${task.id} preflight requires exampleArgs.capability`,
    );
  }
  const capability = CAPABILITY_CATALOG.find(({ id }) => id === capabilityId);
  if (capability === undefined) {
    return panic(
      `agent-orientation eval: ${task.id} references unknown capability ${capabilityId}`,
    );
  }
  return [
    "Eval scope: post-discovery first-call authoring. A read-only describe_capability call has already returned this canonical capability. Do not call describe_capability; make the one invoke_capability call that would perform the requested action. This eval captures the call but never executes it.",
    JSON.stringify({
      id: capability.id,
      description: capability.description,
      inputSchema: capability.inputSchema,
    }),
  ].join("\n");
};

const mcpWorkflowScope = (task: Task): WorkflowScope =>
  task.mcp.preflight === undefined ? "first-call" : "post-discovery-first-call";

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
    system: [MCP_SYSTEM_PROMPT, mcpPreflightContext(task)]
      .filter((prompt) => prompt.length > 0)
      .join("\n\n"),
    request: task.request,
    tools,
  });
  const score = scoreMcpRun({ task, turn });
  return {
    modelId,
    taskId: task.id,
    surface: "mcp",
    workflowScope: mcpWorkflowScope(task),
    repeat,
    ...score,
    call: turn.call,
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
    workflowScope: "first-call",
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
      "| surface | scope | task | run | outcome | tool/command | args | issues | ms |",
      "| --- | --- | --- | ---: | --- | --- | --- | --- | ---: |",
    );
    for (const run of modelRuns) {
      lines.push(
        [
          `| ${run.surface}`,
          run.workflowScope,
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
  assertMcpTaskFixtures(tasks);
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
            ? runMcpTask({
                model,
                modelId: id,
                task,
                repeat,
                tools:
                  task.mcp.exposedTools === undefined
                    ? mcpTools
                    : buildMcpClientTools(new Set(task.mcp.exposedTools)),
              })
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
