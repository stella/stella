// THE agent-skill emitter (TanStack Intent). Given the same registry inputs as
// `generateRouteMap` (the `tools/list` projection plus the baked-in Annotation
// Table) it emits the `SKILL.md` markdown a coding agent loads to drive the
// stella CLI. Pure and deterministic: same inputs -> byte-identical markdown,
// no I/O, no `Date.now()`/`Math.random()`. The command tree is walked out of
// the real `generateRouteMap` output, so the documented surface can never drift
// from the command surface the CLI actually dispatches.

import { CLI_DEFAULT_SCOPES } from "./auth/constants.js";
import { uploadSpecificFlags } from "./commands/upload.js";
import { flagKindFact } from "./flag-help.js";
import { CAPABILITY_NAMESPACE } from "./generate-capability-tree.js";
import {
  generateRouteMap,
  kebabCase,
  RouteGenerationError,
} from "./generate-route-map.js";
import { DOCUMENT_VERSION_UPLOAD_TRANSPORT } from "./generated/document-version-upload-transport.js";
import {
  buildInputContractHelp,
  formatInputExample,
} from "./input-contract-help.js";
import { exitCodeEntries } from "./mcp-constants.js";
import type {
  FlagSpec,
  JsonSchema,
  LeafCommandSpec,
  RegistryToolListing,
  RouteNode,
  ToolAnnotation,
} from "./route-types.js";

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * The skill's leaf name. Intent requires `skills/<name>/SKILL.md` where the
 * frontmatter `name` matches the parent directory, so this drives both the
 * emitted frontmatter and the codegen output path.
 */
export const SKILL_NAME = "stella-cli";

type CommandRow = {
  domain: string;
  command: string;
  access: string;
  notes: string;
};

/**
 * Depth-first walk collecting every curated leaf spec under a route node. The
 * skill's command table documents curated commands; the generated capability
 * leaves are summarized in their own section, so they are skipped here.
 */
const collectLeaves = (node: RouteNode, acc: LeafCommandSpec[]): void => {
  if (node.kind === "leaf") {
    acc.push(node.spec);
    return;
  }
  if (node.kind === "capability-leaf") {
    return;
  }
  for (const child of Object.values(node.children)) {
    collectLeaves(child, acc);
  }
};

const notesFor = (spec: LeafCommandSpec): string => {
  const parts: string[] = [];
  if (spec.destructive) {
    parts.push("destructive (needs `--yes` off a TTY)");
  }
  if (spec.paginated) {
    parts.push("paginated");
  }
  if (spec.windowedText) {
    parts.push("windowed text");
  }
  return parts.join("; ");
};

/**
 * Every curated leaf, sorted for determinism independent of
 * registry/annotation iteration order. Explicit locale keeps the ordering
 * byte-identical across machines; the drift guard diffs the emitted SKILL.md
 * against a committed snapshot. Both the command table and the per-command
 * flag section below walk this SAME list, so they can never fall out of sync
 * with each other.
 */
const sortedLeaves = (tree: RouteNode): readonly LeafCommandSpec[] => {
  const leaves: LeafCommandSpec[] = [];
  collectLeaves(tree, leaves);
  return leaves.toSorted((a, b) =>
    a.commandPath.join(" ").localeCompare(b.commandPath.join(" "), "en"),
  );
};

const commandRows = (
  leaves: readonly LeafCommandSpec[],
): readonly CommandRow[] =>
  leaves.map((spec) => {
    const command = spec.commandPath.join(" ");
    return {
      domain: spec.commandPath[0] ?? command,
      command: `stella ${command}`,
      access:
        [
          ...(spec.scope === undefined ? [] : [spec.scope]),
          ...(spec.additionalScopes ?? []),
        ].join(" + ") || "—",
      notes: notesFor(spec),
    };
  });

const renderCommandTable = (rows: readonly CommandRow[]): string => {
  const lines = [
    "| Domain | Command | Access | Notes |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.domain} | \`${row.command}\` | ${row.access} | ${row.notes} |`,
    );
  }
  return lines.join("\n");
};

/**
 * Global flags every command carries (`buildLeafFlags` in `build-cli-tree.ts`)
 * and that "Conventions every agent must know" already documents once. A
 * tool-derived `FlagSpec` can never actually collide with one of these
 * (`generate-route-map.ts` throws on the collision at codegen time), so this
 * filter is a defensive no-op today; it stays so a per-command line can never
 * silently repeat a convention flag if that invariant ever changes.
 */
const CONVENTION_FLAGS: ReadonlySet<string> = new Set([
  "--output",
  "--cursor",
  "--limit",
  "--all",
  "--yes",
  "--input",
]);

/** An optional flag's compact token: its name, plus enum values in parens. */
const optionalFlagToken = (flag: FlagSpec): string =>
  flag.enum === undefined ? flag.flag : `${flag.flag} (${flag.enum.join("|")})`;

/**
 * A required flag's full line: name, description, type/enum (via the SAME
 * `flagKindFact` derivation `--help` uses, so it can never drift). The
 * required/optional word is dropped: every flag documented here IS required
 * (an optional flag never reaches this branch), so repeating it would only
 * cost space.
 */
const requiredFlagLine = (flag: FlagSpec): string => {
  const facts = flag.repeatable
    ? `${flagKindFact(flag)}, repeatable`
    : flagKindFact(flag);
  const description =
    flag.description === undefined ? "" : ` — ${oneLine(flag.description)}`;
  return `\`${flag.flag}\`${description} (${facts})`;
};

/**
 * One curated command's flags as a bullet block. A required flag keeps a full
 * line; optional flags collapse to one names-only line (enum values kept, in
 * parens) so the skill stays small enough to load into every agent's context
 * — `--help` remains the source for an optional flag's full description.
 */
const commandFlagsBlock = (spec: LeafCommandSpec): string => {
  const command = `stella ${spec.commandPath.join(" ")}`;
  const flags = spec.flags.filter((flag) => !CONVENTION_FLAGS.has(flag.flag));
  if (flags.length === 0) {
    const hint =
      spec.inputOnly.length > 0
        ? `no flags; pass \`--input\` with ${spec.inputOnly.join(", ")}`
        : "no arguments";
    return `- \`${command}\` — ${hint}`;
  }
  const required = flags.filter((flag) => flag.required);
  const optional = flags.filter((flag) => !flag.required);
  const lines = [
    `- \`${command}\``,
    ...required.map((flag) => `  - ${requiredFlagLine(flag)}`),
  ];
  if (optional.length > 0) {
    lines.push(`  - optional: ${optional.map(optionalFlagToken).join(", ")}`);
  }
  return lines.join("\n");
};

const renderCommandFlagsSection = (
  leaves: readonly LeafCommandSpec[],
): string =>
  [
    "## Command flags",
    "",
    "Required: `--flag — description (type)`. Optional: one `optional: --a,",
    "--b (enum1|enum2)` line, names only (`--help` has full descriptions).",
    "Global flags (output/cursor/limit/all/yes/input; see Conventions above)",
    "are omitted here.",
    "",
    leaves.map((spec) => commandFlagsBlock(spec)).join("\n"),
  ].join("\n");

const renderExitCodeTable = (): string =>
  [
    "| Code | Meaning |",
    "| --- | --- |",
    ...exitCodeEntries().map(({ code, meaning }) => `| ${code} | ${meaning} |`),
  ].join("\n");

/** The capability-tree facts the skill documents (spec 049 deliverable 4). */
export type CapabilitySkillSummary = {
  /** Count of generated `invoke_capability`-backed leaf commands. */
  commandCount: number;
  /** Domain segments actually present in the merged tree, see `capabilityDomainsOf`. */
  domains: readonly string[];
  /**
   * The merged tree (curated leaves + capability leaves). Worked examples
   * below resolve a real `CapabilityLeafSpec` out of it, so an example's
   * flags are derived from the leaf, never hand-typed.
   */
  tree: RouteNode;
};

/** The node at `path` in `tree`, or `undefined` if the path does not resolve. */
const routeNodeAt = (
  tree: RouteNode,
  path: readonly string[],
): RouteNode | undefined => {
  let node: RouteNode = tree;
  for (const segment of path) {
    if (node.kind !== "route") {
      return undefined;
    }
    const child = node.children[segment];
    if (child === undefined) {
      return undefined;
    }
    node = child;
  }
  return node;
};

/**
 * Two worked "no curated command" examples (spec 049-flags deliverable 2):
 * task prose plus the command path to a real capability leaf. The invocation
 * — every required flag, in the leaf's own flag order, placeholder named
 * after the flag itself, plus a schema-derived `--input` payload for the
 * parts no flag can address — is derived from that leaf at render time (see
 * `capabilityExampleLine`), so a catalog change that renames a flag, adds a
 * new required one, reshapes the body, or drops the leaf fails codegen
 * instead of shipping a stale example.
 */
const CAPABILITY_WORKED_EXAMPLES = [
  {
    task: "Start a document translation run",
    commandPath: [CAPABILITY_NAMESPACE, "document-translations", "runs-create"],
  },
  {
    task: "Start workflow extraction",
    commandPath: [CAPABILITY_NAMESPACE, "workspaces", "workflow-start"],
  },
] as const;

const capabilityExampleLine = (
  tree: RouteNode,
  example: (typeof CAPABILITY_WORKED_EXAMPLES)[number],
): string => {
  const node = routeNodeAt(tree, example.commandPath);
  const leaf = node?.kind === "capability-leaf" ? node : null;
  const inputArg = leaf === null ? null : inputOnlyExampleArg(leaf.spec);
  if (leaf === null || inputArg === null) {
    throw new RouteGenerationError(
      leaf === null
        ? `generateCliSkill: worked example "${example.task}" names command "stella ${example.commandPath.join(" ")}", which is not a capability command in the current tree; update or drop the example`
        : `generateCliSkill: worked example "${example.task}" needs an \`--input\` payload, but no complete example can be derived from the capability's schema; pick a flag-addressable example`,
    );
  }
  const required = leaf.spec.flags.filter((flag) => flag.required);
  const args = required
    .map((flag) => `${flag.flag} <${flag.flag.replace(/^--/u, "")}>`)
    .join(" ");
  const invocation = [`stella ${example.commandPath.join(" ")}`, args, inputArg]
    .filter((part) => part.length > 0)
    .join(" ");
  return `- ${example.task}: \`${invocation}\`.`;
};

// The parts of a capability's input that no generated flag addresses (a body
// that is a union, say) are reachable only through `--input`. An example that
// showed the flags alone would fail validation when copied, so those parts
// are rendered from the schema; the flag-addressed parts stay out of the
// payload rather than appearing twice. `null` when the schema yields no
// complete example, which the caller turns into a codegen failure.
const inputOnlyExampleArg = (spec: {
  inputSchema: JsonSchema;
  inputOnly: readonly string[];
}): string | null => {
  const help = buildInputContractHelp({
    schema: spec.inputSchema,
    inputOnly: spec.inputOnly,
  });
  if (help === undefined) {
    return "";
  }
  if (help.example.status !== "complete") {
    return null;
  }
  const partRoots = new Set(spec.inputOnly.map((path) => path.split(".")[0]));
  const payload = Object.fromEntries(
    Object.entries(help.example.value).filter(([key]) => partRoots.has(key)),
  );
  return formatInputExample(payload);
};

/**
 * The compact capability-tree section (spec 049 deliverable 4), extended with
 * the domain list, two worked examples, and the `--input` casing rule (spec
 * 049-flags deliverable 2). The curated command table above stays the primary
 * surface; the long tail is described (count + discovery) rather than
 * enumerated, so the skill stays readable.
 */
const renderCapabilitySection = (summary: CapabilitySkillSummary): string => {
  const exampleLines = CAPABILITY_WORKED_EXAMPLES.map((example) =>
    capabilityExampleLine(summary.tree, example),
  );
  const domainList = summary.domains
    .map((domain) => `\`${domain}\``)
    .join(", ");
  return [
    "## Capability commands (full surface)",
    "",
    `Beyond the curated commands above, the CLI generates ${summary.commandCount}`,
    "capability commands from the server's capability catalog: every safe handler",
    "that is not a curated tool, reached through the generic `invoke_capability`",
    `path. Every generated command lives at \`stella ${CAPABILITY_NAMESPACE} <domain> <action>\`;`,
    "multi-segment capability actions are flattened with hyphens into `<action>`.",
    "",
    "- **Discover**: `stella capability list [--domain <d>] [--access read|write]`",
    "  enumerates them (paginated); `stella capability describe <id>` prints one",
    "  capability's full input schema, scope, and flags.",
    "- **Invoke by id** (forward-compatible with any server): `stella capability",
    "  invoke <id> --input '<json>'`, where the JSON is `{ body?, params?, query? }`.",
    "- **Flags**: each capability command derives flags from its input schema;",
    "  workspace-scoped capabilities take a required `--workspace-id <id>`. Deep or",
    "  ambiguous payloads use `--input` (the whole `{ body?, params?, query? }`).",
    "- **Dry run**: write capabilities accept `--dry-run`, which validates the input",
    "  server-side and returns without executing (maps to `validate_only`).",
    "- **Destructive** capabilities prompt on a TTY and need `--yes` off a TTY; the",
    "  server's per-capability confirm gate is satisfied automatically once confirmed.",
    "- Exit codes are identical to the curated commands (see above).",
    "",
    "### When no curated command fits",
    "",
    "The curated commands above cover common tasks; anything else goes through the",
    `generic capability path. Current domains: ${domainList}.`,
    "",
    ...exampleLines,
    "- **`--input` casing is not uniform; never guess it.** A curated command's",
    "  `--input` JSON (the table and flags above) uses the MCP tool schema's own",
    "  keys, snake_case (`workspace_id`, `contact_id`). A capability command's",
    "  `--input` JSON uses the handler schema's own keys, camelCase (`fieldId`,",
    "  `workspaceId`). Run `stella <command> --help` or `stella capability describe",
    "  <id>` and copy the field paths it prints.",
  ].join("\n");
};

type UploadFlagEntry =
  (typeof uploadSpecificFlags)[keyof typeof uploadSpecificFlags];

const isOptionalUploadFlag = (flag: UploadFlagEntry): boolean =>
  "optional" in flag;

const uploadFlagName = (key: string): string => `--${kebabCase(key)}`;

/** `stella upload`'s required flags, in invocation order (spec upload-note). */
const REQUIRED_UPLOAD_KEYS = ["file", "workspaceId"] as const;

/**
 * Documents the real `stella upload` invocation, including uploading a new
 * document VERSION (`--entity-id`) — a hand-wired top-level command
 * (`commands/upload.ts`, registered directly in `build-cli-tree.ts`, never
 * part of the generated route tree `generateRouteMap` walks). Its required
 * flags are read off `uploadSpecificFlags`, the SAME object `buildCommand`
 * registers, so the invocation cannot silently drift from what the command
 * actually accepts. Contrasted with the excluded MCP tools
 * (`document-version-upload-transport.ts`), which take a host-supplied file
 * reference the CLI has no channel for and are genuinely unreachable.
 */
const renderUploadNote = (
  annotations: Readonly<Record<string, ToolAnnotation>>,
): string => {
  const { toolName, pickerToolName } = DOCUMENT_VERSION_UPLOAD_TRANSPORT;
  if (
    annotations[toolName]?.excluded !== true ||
    annotations[pickerToolName]?.excluded !== true
  ) {
    throw new RouteGenerationError(
      `generateCliSkill: expected "${toolName}" and "${pickerToolName}" to be excluded CLI tools (host-file-reference upload); update the upload note if that changed`,
    );
  }
  for (const key of REQUIRED_UPLOAD_KEYS) {
    if (isOptionalUploadFlag(uploadSpecificFlags[key])) {
      throw new RouteGenerationError(
        `generateCliSkill: expected "stella upload" flag "${uploadFlagName(key)}" to be required; update the upload note if that changed`,
      );
    }
  }
  if (!isOptionalUploadFlag(uploadSpecificFlags.entityId)) {
    throw new RouteGenerationError(
      'generateCliSkill: expected "stella upload" to offer an optional --entity-id (new-version mode); update the upload note if that changed',
    );
  }
  const requiredInvocation = REQUIRED_UPLOAD_KEYS.map(
    (key) => `${uploadFlagName(key)} <${kebabCase(key)}>`,
  ).join(" ");
  return (
    `- **Uploading a file**: \`stella upload ${requiredInvocation}\` uploads ` +
    `a local file as a new document; add \`${uploadFlagName("entityId")} <id>\` ` +
    "to upload it as a new version of an existing document instead — a " +
    "CLI-native path (the CLI reads the file itself), separate from the MCP " +
    `\`${toolName}\`/\`${pickerToolName}\` tools (which take a host-supplied ` +
    "file reference and are excluded from the CLI)."
  );
};

/**
 * Emit the `SKILL.md` markdown for the stella CLI. Pure over the registry
 * inputs plus the compiled `EXIT_CODES` constant. The command tree is derived
 * from `generateRouteMap`, never hand-written.
 */
export const generateCliSkill = (
  listings: readonly RegistryToolListing[],
  annotations: Readonly<Record<string, ToolAnnotation>>,
  capability: CapabilitySkillSummary,
): string => {
  const tree = generateRouteMap(listings, annotations);
  const leaves = sortedLeaves(tree);
  const table = renderCommandTable(commandRows(leaves));
  const flagsSection = renderCommandFlagsSection(leaves);
  const exitCodes = renderExitCodeTable();
  const capabilitySection = renderCapabilitySection(capability);
  const uploadNote = renderUploadNote(annotations);

  const frontmatter = [
    "---",
    `name: ${SKILL_NAME}`,
    "description: >-",
    "  Drive the stella command-line client (@stll/cli), a legal-workspace CLI whose",
    "  command surface is generated from the stella MCP tool registry. Covers install,",
    "  OAuth login, the full command tree grouped by domain, JSON output for scripting,",
    "  the --input escape hatch for deep payloads, cursor pagination, destructive-op",
    "  confirmation, and exit codes.",
    "metadata:",
    "  type: reference",
    '  library: "@stll/cli"',
    "---",
  ].join("\n");

  const body = [
    "<!-- GENERATED by `bun run codegen` (packages/cli/src/generate-skill.ts). Do not edit by hand. -->",
    "",
    "# stella CLI",
    "",
    "`@stll/cli` is the command-line client for stella, an open-source legal",
    "workspace. Curated tools use `stella <domain> <action>`; generated capability",
    `commands use \`stella ${CAPABILITY_NAMESPACE} <domain> <action>\`. Both surfaces are`,
    "generated from the stella MCP tool registry, so they mirror exactly the tools",
    "a stella server exposes. Every command works for humans, scripts, and agents alike.",
    "",
    "## Install",
    "",
    "```sh",
    "npm i -g @stll/cli",
    "```",
    "",
    "## Authenticate",
    "",
    "```sh",
    "stella auth login --server <url>",
    "```",
    "",
    "Login runs an OAuth 2.1 authorization-code flow with PKCE against the stella",
    "server, using a loopback listener (`http://127.0.0.1/callback`, ephemeral port)",
    "to capture the code. Credentials are stored per server origin, so one machine",
    "can hold sessions for several servers at once. The first login needs",
    "`--server <url>` (or `STELLA_SERVER_URL`); it then becomes the default, and",
    "every command accepts `--server <url>` to target another one. A default",
    "login requests the working set of scopes (everything but organization",
    "administration writes and one-off setup); pass `--scopes` to request an",
    "explicit set. The",
    `default scopes are \`${CLI_DEFAULT_SCOPES.join(" ")}\`.`,
    "`stella auth whoami` shows the active session; `stella auth logout` clears it.",
    "",
    "## Conventions every agent must know",
    "",
    "- **Output format**: table is the default only on a TTY; piped/non-TTY output",
    "  defaults to JSON. Force it with `--output json|table` (or `--json` / `--table`).",
    "  Always pass `--output json` when scripting or parsing.",
    "- **Deep payloads**: any command accepts `--input '<json>'` for the whole tool",
    "  argument object, `--input @file` to read JSON from a file, or `--input -` to",
    "  read JSON from stdin. Individual string flags also take gh-style `@file` / `@-`",
    "  sugar (use `@@` to pass a literal leading `@`).",
    "- **Array flags** are repeatable: pass the flag once per value.",
    "- **Pagination**: list commands take `--cursor <c>` and `--limit <n>`; `--all`",
    "  follows cursors up to bounded ceilings. The `nextCursor` resume hint is written",
    "  to stderr (`more: --cursor <c>`) so piped JSON on stdout stays clean.",
    "- **Destructive commands** (delete/remove) prompt for confirmation on a TTY and",
    "  require `--yes` when there is no TTY to confirm on. The CLI owns the server's",
    "  `confirm` gate: it injects `confirm: true` only after you confirm (or pass",
    "  `--yes`), so there is no separate `--confirm` flag to pass.",
    "- **Errors** print `error: <message>` (and `hint: <next step>` when the server",
    "  supplies one) to stderr as plain text, never to stdout, so a scripted stdout",
    "  stays clean even with `--output json`. Every tool error carries a stable",
    "  machine `code` that maps to the process exit code (see below): branch on the",
    "  exit code, and read the `error:`/`hint:` lines for the human-readable message.",
    "- **Finding and reading text**: `stella search matters --query '<q>'` returns",
    "  matching documents with their entity ids, and",
    "  `stella document content --entity-id <id>` prints one document's text",
    "  (windowed, so follow `--cursor`).",
    "- **MCP resources**: `stella reference list` enumerates static server resources;",
    "  `stella reference show <name>` prints one.",
    uploadNote,
    "",
    "## Command tree",
    "",
    "Generated from the MCP tool registry; `Access` is the OAuth scope the command",
    "requires (request it at `stella auth login --scopes`).",
    "",
    table,
    "",
    flagsSection,
    "",
    "## Exit codes",
    "",
    exitCodes,
    "",
    "The exit code lines up with the tool-error `code`: `validation_error` -> 2,",
    "`missing_scope` -> 3, `feature_disabled` -> 5, `not_found` -> 6,",
    "`confirmation_required` -> 7, and `rate_limited` / `upstream_unavailable` /",
    "`unknown_tool` / `internal_error` -> 4. A legacy server that tags only a bare `feature_disabled`",
    "code (no envelope) still maps to 5; anything else falls to 4.",
    "",
    capabilitySection,
    "",
    "## Filing feedback",
    "",
    "`stella feedback send` files a bug, feature request, or docs issue with the",
    "maintainers. Content is sanitized server-side (emails, ids, secrets, URLs, and",
    "IPs are redacted); never include tenant data, client or matter names, ids, or",
    "secrets: describe the problem, reproduction steps, and expected vs actual",
    "result. Pass `--kind`, `--title`, and `--body`.",
    "",
    "- **github** (preferred): returns a prefilled new-issue URL and a `gh` command",
    "  the human opens and submits under their own GitHub account. The CLI never",
    "  publishes anything itself.",
    "",
  ].join("\n");

  return `${frontmatter}\n${body}`;
};
