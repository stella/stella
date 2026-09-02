// THE agent-skill emitter (TanStack Intent). Given the same registry inputs as
// `generateRouteMap` (the `tools/list` projection plus the baked-in Annotation
// Table) it emits the `SKILL.md` markdown a coding agent loads to drive the
// stella CLI. Pure and deterministic: same inputs -> byte-identical markdown,
// no I/O, no `Date.now()`/`Math.random()`. The command tree is walked out of
// the real `generateRouteMap` output, so the documented surface can never drift
// from the command surface the CLI actually dispatches.

import { CLI_DEFAULT_SCOPES } from "./auth/constants.js";
import { flagKindFact } from "./flag-help.js";
import { CAPABILITY_NAMESPACE } from "./generate-capability-tree.js";
import {
  generateRouteMap,
  RouteGenerationError,
} from "./generate-route-map.js";
import { DOCUMENT_VERSION_UPLOAD_TRANSPORT } from "./generated/document-version-upload-transport.js";
import { exitCodeEntries } from "./mcp-constants.js";
import type {
  FlagSpec,
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
};

/**
 * Two worked "no curated command" examples the skill states verbatim
 * (spec 049-flags deliverable 2). Checked against the live domain list below
 * rather than hand-trusted, so a catalog change that removes either domain
 * fails codegen instead of shipping a stale example.
 */
const CAPABILITY_WORKED_EXAMPLES = [
  {
    domain: "entities",
    task: "Translate a document",
    command:
      "stella capability entities translate --field-id <id> --target-lang <lang>",
  },
  {
    domain: "workspaces",
    task: "Start workflow extraction",
    command: "stella capability workspaces workflow-start --workspace <id>",
  },
] as const;

/**
 * The compact capability-tree section (spec 049 deliverable 4), extended with
 * the domain list, two worked examples, and the `--input` casing rule (spec
 * 049-flags deliverable 2). The curated command table above stays the primary
 * surface; the long tail is described (count + discovery) rather than
 * enumerated, so the skill stays readable.
 */
const renderCapabilitySection = (summary: CapabilitySkillSummary): string => {
  for (const example of CAPABILITY_WORKED_EXAMPLES) {
    if (!summary.domains.includes(example.domain)) {
      throw new RouteGenerationError(
        `generateCliSkill: worked example "${example.command}" names domain "${example.domain}", which is no longer in the capability tree; update or drop the example`,
      );
    }
  }
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
    "  workspace-scoped capabilities take a required `--workspace <id>`. Deep or",
    "  ambiguous payloads use `--input` (the whole `{ body?, params?, query? }`).",
    "- **Dry run**: `--dry-run` validates the input server-side and returns without",
    "  executing (maps to `validate_only`).",
    "- **Destructive** capabilities prompt on a TTY and need `--yes` off a TTY; the",
    "  server's per-capability confirm gate is satisfied automatically once confirmed.",
    "- Exit codes are identical to the curated commands (see above).",
    "",
    "### When no curated command fits",
    "",
    "The curated commands above cover common tasks; anything else goes through the",
    `generic capability path. Current domains: ${domainList}.`,
    "",
    ...CAPABILITY_WORKED_EXAMPLES.map(
      ({ task, command }) => `- ${task}: \`${command}\`.`,
    ),
    "- **`--input` casing is not uniform; never guess it.** A curated command's",
    "  `--input` JSON (the table and flags above) uses the MCP tool schema's own",
    "  keys, snake_case (`matter_id`, `contact_id`). A capability command's",
    "  `--input` JSON uses the handler schema's own keys, camelCase (`fieldId`,",
    "  `workspaceId`). Run `stella <command> --help` or `stella capability describe",
    "  <id>` and copy the field paths it prints.",
  ].join("\n");
};

/**
 * What the CLI structurally cannot do: binary-file MCP tools have no JSON
 * transport to ride. Derived from the two tools the document-version-upload
 * feature is built from (`document-version-upload-transport.ts`) so the note
 * disappears on its own if either tool is ever dropped from the exclusion
 * list, instead of silently going stale.
 */
const renderUploadGapNote = (
  annotations: Readonly<Record<string, ToolAnnotation>>,
): string => {
  const { toolName, pickerToolName } = DOCUMENT_VERSION_UPLOAD_TRANSPORT;
  if (
    annotations[toolName]?.excluded !== true ||
    annotations[pickerToolName]?.excluded !== true
  ) {
    throw new RouteGenerationError(
      `generateCliSkill: expected "${toolName}" and "${pickerToolName}" to be excluded CLI tools (binary file upload); update the upload-gap note if that changed`,
    );
  }
  return (
    "- **No binary uploads**: the CLI cannot upload a new document version " +
    `(a file) — \`${toolName}\`/\`${pickerToolName}\` are MCP-only, excluded ` +
    "from the CLI. Upload a new version through an MCP-connected client or the " +
    "stella web app."
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
  const uploadGapNote = renderUploadGapNote(annotations);

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
    "every command accepts `--server <url>` to target another one. Scope the",
    "session with `--scopes`; the default scopes are",
    `\`${CLI_DEFAULT_SCOPES.join(" ")}\`.`,
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
    uploadGapNote,
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
