// THE agent-skill emitter (TanStack Intent). Given the same registry inputs as
// `generateRouteMap` (the `tools/list` projection plus the baked-in Annotation
// Table) it emits the `SKILL.md` markdown a coding agent loads to drive the
// stella CLI. Pure and deterministic: same inputs -> byte-identical markdown,
// no I/O, no `Date.now()`/`Math.random()`. The command tree is walked out of
// the real `generateRouteMap` output, so the documented surface can never drift
// from the command surface the CLI actually dispatches.

import { panic } from "better-result";

import { generateRouteMap } from "./generate-route-map.js";
import { EXIT_CODES } from "./mcp-constants.js";
import type {
  LeafCommandSpec,
  RegistryToolListing,
  RouteNode,
  ToolAnnotation,
} from "./route-types.js";

/**
 * The skill's leaf name. Intent requires `skills/<name>/SKILL.md` where the
 * frontmatter `name` matches the parent directory, so this drives both the
 * emitted frontmatter and the codegen output path.
 */
export const SKILL_NAME = "stella-cli";

/**
 * Human meaning for each `EXIT_CODES` key. Typed `satisfies
 * Record<keyof typeof EXIT_CODES, string>` so a new exit code fails typecheck
 * here until it is described; the rendered code column is read from
 * `EXIT_CODES` itself, so the table can never drift from the compiled
 * exit-code constant. Declaration order is irrelevant: the table is rendered
 * sorted numerically by exit-code value.
 */
const EXIT_CODE_DESCRIPTIONS = {
  ok: "success",
  unexpected: "unexpected internal error",
  validation: "usage or input validation error",
  auth: "authentication required or failed (run `stella auth login`)",
  server: "server or tool error",
  featureDisabled: "feature disabled for this organization",
  notFound: "resource not found",
  aborted: "confirmation aborted (a destructive op was declined)",
} satisfies Record<keyof typeof EXIT_CODES, string>;

type CommandRow = {
  domain: string;
  command: string;
  access: string;
  notes: string;
};

/** Depth-first walk collecting every leaf spec under a route node. */
const collectLeaves = (node: RouteNode, acc: LeafCommandSpec[]): void => {
  if (node.kind === "leaf") {
    acc.push(node.spec);
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

const commandRows = (tree: RouteNode): readonly CommandRow[] => {
  const leaves: LeafCommandSpec[] = [];
  collectLeaves(tree, leaves);
  const rows = leaves.map((spec) => {
    const command = spec.commandPath.join(" ");
    return {
      domain: spec.commandPath[0] ?? command,
      command: `stella ${command}`,
      access: spec.scope ?? "—",
      notes: notesFor(spec),
    };
  });
  // Sort for determinism independent of registry/annotation iteration order.
  // Explicit locale keeps the ordering byte-identical across machines; the
  // drift guard diffs the emitted SKILL.md against a committed snapshot.
  return rows.toSorted((a, b) => a.command.localeCompare(b.command, "en"));
};

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

const renderExitCodeTable = (): string => {
  const lines = ["| Code | Meaning |", "| --- | --- |"];
  // Iterate `EXIT_CODES` (the source of truth) and look descriptions up
  // through a widened alias, so no cast is needed: exhaustiveness is already
  // compile-forced on the `EXIT_CODE_DESCRIPTIONS` literal by its `satisfies`.
  const descriptions: Record<string, string> = EXIT_CODE_DESCRIPTIONS;
  const sorted = Object.entries(EXIT_CODES).toSorted(([, a], [, b]) => a - b);
  for (const [key, code] of sorted) {
    const meaning =
      descriptions[key] ?? panic(`exit code ${key} has no description`);
    lines.push(`| ${code} | ${meaning} |`);
  }
  return lines.join("\n");
};

/**
 * Emit the `SKILL.md` markdown for the stella CLI. Pure over the registry
 * inputs plus the compiled `EXIT_CODES` constant. The command tree is derived
 * from `generateRouteMap`, never hand-written.
 */
export const generateCliSkill = (
  listings: readonly RegistryToolListing[],
  annotations: Readonly<Record<string, ToolAnnotation>>,
): string => {
  const tree = generateRouteMap(listings, annotations);
  const table = renderCommandTable(commandRows(tree));
  const exitCodes = renderExitCodeTable();

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
    "workspace. Its command surface (`stella <domain> <action>`) is generated from",
    "the stella MCP tool registry, so it mirrors exactly the tools a stella server",
    "exposes. Every command works for humans, scripts, and agents alike.",
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
    "stella auth login",
    "```",
    "",
    "Login runs an OAuth 2.1 authorization-code flow with PKCE against the stella",
    "server, using a loopback listener (`http://127.0.0.1/callback`, ephemeral port)",
    "to capture the code. Credentials are stored per server origin, so one machine",
    "can hold sessions for several servers at once. Point at a non-default server",
    "with `--server <url>`; scope the session with `--scopes` (default scopes:",
    "`openid profile email stella:read stella:search`). `stella auth whoami` shows",
    "the active session; `stella auth logout` clears it.",
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
    "- **MCP resources**: `stella reference list` enumerates static server resources;",
    "  `stella reference show <name>` prints one.",
    "",
    "## Exit codes",
    "",
    exitCodes,
    "",
    "The exit code lines up with the tool-error `code`: `validation_error` -> 2,",
    "`missing_scope` -> 3, `feature_disabled` -> 5, `not_found` -> 6,",
    "`confirmation_required` -> 7, and `rate_limited` / `unknown_tool` /",
    "`internal_error` -> 4. A legacy server that tags only a bare `feature_disabled`",
    "code (no envelope) still maps to 5; anything else falls to 4.",
    "",
    "## Filing feedback",
    "",
    "`stella feedback send` files a bug, feature request, or docs issue with the",
    "maintainers. Content is sanitized server-side (emails, ids, secrets, URLs, and",
    "IPs are redacted); never include tenant data, client or matter names, ids, or",
    "secrets: describe the problem, reproduction steps, and expected vs actual",
    "result. Pass `--kind`, `--title`, and `--body`, and choose the channel with",
    "`--channel github|email|stella` (default `github`).",
    "",
    "- **github** (preferred): returns a prefilled new-issue URL and a `gh` command",
    "  the human opens and submits under their own GitHub account. The CLI never",
    "  publishes anything itself.",
    "- **email / stella**: fallbacks for a human with no GitHub account. Both need a",
    "  two-step approval: the first call returns `status: approval_required` with a",
    "  `confirmation_token`; show the sanitized content to the human, then re-run the",
    "  same command with `--confirmation-token <token>` to deliver it.",
    "",
    "## Command tree",
    "",
    "Generated from the MCP tool registry; `Access` is the OAuth scope the command",
    "requires (request it at `stella auth login --scopes`).",
    "",
    table,
    "",
  ].join("\n");

  return `${frontmatter}\n${body}`;
};
