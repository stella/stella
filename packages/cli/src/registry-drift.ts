// How a diverged server registry is reported (spec 051 S5.3, reporting half).
// `registry-refresh.ts` decides WHAT diverged; this module decides who hears
// about it and in how much detail.
//
// The drift is a persistent state, not an event: it holds until the next
// refresh reconciles the cache. Printing the full tool lists on every
// invocation (including `--help`) buried the command's own output in noise, so
// the default is one counted line on stderr and the names arrive only under
// `--verbose`.

import { panic } from "better-result";

import { commandNeedsRegistry } from "./command-locality.js";
import type { RegistryDelta } from "./registry-cache.js";
import { RESERVED_FLAG_KEYS } from "./reserved-flag-keys.js";
import type { RouteNode } from "./route-types.js";

const VERBOSE_FLAG = `--${RESERVED_FLAG_KEYS.verbose}`;

/** The generic tool every capability leaf dispatches through. */
const INVOKE_CAPABILITY_TOOL = "invoke_capability";

/**
 * Whether this invocation hears about registry drift at all. A command that
 * reads no server-derived command tree (`--help`, `auth`, `compatibility`,
 * `tools`, `upload`) also skips the cache refresh, so the drift says nothing
 * about what it is doing; the same predicate decides both, and they cannot
 * drift apart. A `--help` anywhere in argv is that case too: the caller is
 * reading the command surface, not running it.
 */
export const shouldReportRegistryDrift = (argv: readonly string[]): boolean => {
  if (!commandNeedsRegistry(argv)) {
    return false;
  }
  for (const arg of argv) {
    if (arg === "--") {
      return true;
    }
    if (arg === "--help" || arg === "-h") {
      return false;
    }
  }
  return true;
};

/** Whether `--verbose` was passed, read before stricli parses (see `cli.ts`). */
export const preparseVerboseFlag = (argv: readonly string[]): boolean => {
  for (const arg of argv) {
    if (arg === "--") {
      return false;
    }
    if (arg === VERBOSE_FLAG) {
      return true;
    }
  }
  return false;
};

/** `1 added, 2 removed` — only the non-empty categories, in a stable order. */
const countsPhrase = (delta: RegistryDelta): string => {
  const counts: string[] = [];
  for (const [label, names] of [
    ["added", delta.added],
    ["removed", delta.removed],
    ["changed", delta.changed],
  ] as const) {
    if (names.length > 0) {
      counts.push(`${names.length} ${label}`);
    }
  }
  return counts.join(", ");
};

/**
 * The stderr report for a diverged registry: one counted line by default, and
 * the complete lists (never truncated) under `--verbose`. The lists are the
 * reason `--verbose` exists, so summarising them there would defeat it.
 */
export const formatRegistryDrift = ({
  delta,
  verbose,
}: {
  delta: RegistryDelta;
  verbose: boolean;
}): string => {
  const counts = countsPhrase(delta);
  if (counts === "") {
    return panic("formatRegistryDrift called with an empty delta");
  }
  const headline = `server registry differs from this CLI build: ${counts}`;
  if (!verbose) {
    return `${headline}; re-run with ${VERBOSE_FLAG} to list the tools\n`;
  }
  const lines = [headline];
  for (const [label, names] of [
    ["added", delta.added],
    ["removed", delta.removed],
    ["changed", delta.changed],
  ] as const) {
    if (names.length > 0) {
      lines.push(`  ${label}: ${names.join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

/** The leading positional tokens of `argv`: the command path stricli routes on. */
const commandPathFromArgv = (argv: readonly string[]): readonly string[] => {
  const segments: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      break;
    }
    segments.push(arg);
  }
  return segments;
};

const nodeAtPath = (
  tree: RouteNode,
  segments: readonly string[],
): RouteNode | undefined => {
  let node: RouteNode = tree;
  for (const segment of segments) {
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

/** The tool a command path dispatches through, or `undefined` for a group. */
const toolNameAt = (
  tree: RouteNode,
  segments: readonly string[],
): string | undefined => {
  const node = nodeAtPath(tree, segments);
  if (node === undefined) {
    return undefined;
  }
  switch (node.kind) {
    case "leaf":
      return node.spec.toolName;
    case "capability-leaf":
      return INVOKE_CAPABILITY_TOOL;
    case "route":
      return undefined;
    default: {
      node satisfies never;
      return panic(`Unhandled route node: ${String(node)}`);
    }
  }
};

/**
 * The error for the one case where drift is not background noise: the command
 * being invoked exists in this CLI build but its tool is gone from the
 * server's registry. Without this the rebuilt tree simply lacks the leaf and
 * stricli reports "unknown command", which sends the caller looking for a typo
 * in a command that is spelled correctly.
 *
 * `baked` is the built-in tree, not the rebuilt one: the rebuilt tree is
 * exactly where the command is missing.
 */
export const removedCommandError = ({
  argv,
  baked,
  delta,
}: {
  argv: readonly string[];
  baked: RouteNode;
  delta: RegistryDelta;
}): string | undefined => {
  if (delta.removed.length === 0) {
    return undefined;
  }
  const segments = commandPathFromArgv(argv);
  if (segments.length === 0) {
    return undefined;
  }
  const toolName = toolNameAt(baked, segments);
  if (toolName === undefined || !delta.removed.includes(toolName)) {
    return undefined;
  }
  return (
    `stella ${segments.join(" ")} is not available on this server: it runs the ` +
    `${toolName} tool, which the server's registry no longer lists.\n` +
    "Run 'stella tools list' for the commands this server offers.\n"
  );
};
