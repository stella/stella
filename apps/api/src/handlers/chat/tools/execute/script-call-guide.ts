import { panic } from "better-result";

import type {
  SandboxNameGuide,
  SandboxNameVerdict,
} from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import { SANDBOX_IDENTIFIER_PATTERN } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox-prelude";
import {
  didYouMean,
  quoteToolName,
  toolNameDistance,
  toolNameKey,
} from "@/api/mcp/tool-utils";

/**
 * What a chat script can and cannot call, for telling a model which call it
 * meant when a script names something that is not a script function.
 *
 * Models conflate the two call surfaces: they write `save_playbook(...)` (a
 * direct tool call, an approval-gated write) inside `execute_typescript`, or
 * drop the `external_` prefix of a read, and a bare `ReferenceError` reads to
 * them as "the tool does not exist". The guide answers each such name with the
 * exact next action, and runs the read it unambiguously meant.
 */
export type ScriptCallCatalog = {
  /**
   * The script's own functions that may run in place of a misspelled call:
   * registry reads that run without an approval. Nothing else is ever run for
   * a guided name.
   */
  readFunctions: readonly string[];
  /** The tools this turn offers as direct tool calls. */
  directTools: readonly string[];
  /** Tools Stella has that this turn does not offer, with why when known. */
  unavailableTools: ReadonlyMap<string, string | undefined>;
};

type Suggestion = { direct: boolean; name: string };

export type ScriptNameVerdict =
  /** (b) One read function matches up to case and prefix: run it. */
  | { kind: "run-read"; name: string; target: string }
  /** (a) A direct tool, which a script cannot call. */
  | {
      kind: "direct-tool";
      name: string;
      tool: string;
      /** The read function of the same name, when there is exactly one. */
      readInstead: string | undefined;
    }
  /** Several read functions match up to case and prefix: run none. */
  | { kind: "ambiguous-read"; name: string; candidates: readonly string[] }
  /** (d) A tool Stella has that this chat does not offer. */
  | {
      kind: "unavailable";
      name: string;
      tool: string;
      reason: string | undefined;
      suggestions: readonly Suggestion[];
    }
  /** (c) A near miss of an offered name: suggest, never run. */
  | { kind: "near-miss"; name: string; suggestions: readonly Suggestion[] }
  /** (e) Nothing the guide knows: the script's own error stands. */
  | { kind: "unknown"; name: string };

/** At most this many names are offered in one "did you mean". */
const MAX_SUGGESTIONS = 3;

/**
 * The edit budget for a near miss: tighter than the MCP gateway's (which
 * only ever sees tool names), because a script's undefined name is as often
 * one of its own variables as a misspelled function.
 */
const nearMissBudget = (candidate: string): number =>
  Math.max(1, Math.floor(toolNameKey(candidate).length / 5));

type ScriptCallIndex = {
  catalog: ScriptCallCatalog;
  directByKey: ReadonlyMap<string, string>;
  readsByKey: ReadonlyMap<string, readonly string[]>;
  unavailableByKey: ReadonlyMap<string, readonly [string, string | undefined]>;
};

const indexCatalog = (catalog: ScriptCallCatalog): ScriptCallIndex => {
  const readsByKey = new Map<string, string[]>();
  for (const name of catalog.readFunctions) {
    const key = toolNameKey(name);
    const known = readsByKey.get(key);
    if (known === undefined) {
      readsByKey.set(key, [name]);
    } else {
      known.push(name);
    }
  }
  const directByKey = new Map<string, string>();
  for (const name of catalog.directTools) {
    const key = toolNameKey(name);
    if (!directByKey.has(key)) {
      directByKey.set(key, name);
    }
  }
  const unavailableByKey = new Map<
    string,
    readonly [string, string | undefined]
  >();
  for (const [name, reason] of catalog.unavailableTools) {
    const key = toolNameKey(name);
    if (!unavailableByKey.has(key)) {
      unavailableByKey.set(key, [name, reason]);
    }
  }
  return { catalog, directByKey, readsByKey, unavailableByKey };
};

const nearMisses = (name: string, catalog: ScriptCallCatalog): Suggestion[] => {
  const scoredAs = (direct: boolean) => (candidate: string) => ({
    direct,
    distance: toolNameDistance(name, candidate),
    name: candidate,
  });
  const scored = [
    ...catalog.readFunctions.map(scoredAs(false)),
    ...catalog.directTools.map(scoredAs(true)),
  ]
    .filter(
      ({ distance, name: candidate }) => distance <= nearMissBudget(candidate),
    )
    .toSorted((a, b) => {
      const distance = a.distance - b.distance;
      if (distance !== 0) {
        return distance;
      }
      if (a.name < b.name) {
        return -1;
      }
      if (a.name > b.name) {
        return 1;
      }
      return 0;
    });
  const [best, second] = scored;
  if (best === undefined) {
    return [];
  }
  // One clearly closest name is offered alone; a tie offers the few closest.
  const offered =
    second === undefined || best.distance < second.distance
      ? [best]
      : scored.slice(0, MAX_SUGGESTIONS);
  return offered.map(({ direct, name: candidate }) => ({
    direct,
    name: candidate,
  }));
};

/**
 * `suggest: false` skips the edit-distance search, for callers that only need
 * to know whether a name is guided (a near miss is never predefined).
 */
const classifyIndexed = (
  name: string,
  index: ScriptCallIndex,
  suggest = true,
): ScriptNameVerdict => {
  const key = toolNameKey(name);
  if (key === "") {
    return { kind: "unknown", name };
  }
  // Every stored list holds at least one name.
  const reads = index.readsByKey.get(key);
  const onlyRead = reads?.length === 1 ? reads[0] : undefined;
  const direct = index.directByKey.get(key);
  if (direct !== undefined) {
    // A read of the same name makes the intent ambiguous, so nothing runs:
    // the answer names both calls.
    return { kind: "direct-tool", name, tool: direct, readInstead: onlyRead };
  }
  if (onlyRead !== undefined) {
    return { kind: "run-read", name, target: onlyRead };
  }
  if (reads !== undefined) {
    return {
      kind: "ambiguous-read",
      name,
      candidates: reads.toSorted().slice(0, MAX_SUGGESTIONS),
    };
  }
  const unavailable = index.unavailableByKey.get(key);
  if (unavailable !== undefined) {
    const [tool, reason] = unavailable;
    return {
      kind: "unavailable",
      name,
      tool,
      reason,
      suggestions: suggest ? nearMisses(name, index.catalog) : [],
    };
  }
  const suggestions = suggest ? nearMisses(name, index.catalog) : [];
  return suggestions.length > 0
    ? { kind: "near-miss", name, suggestions }
    : { kind: "unknown", name };
};

/** How a name a script called relates to what this chat offers. */
export const classifyScriptName = (
  name: string,
  catalog: ScriptCallCatalog,
): ScriptNameVerdict => classifyIndexed(name, indexCatalog(catalog));

const suggestionLabel = ({ direct, name }: Suggestion): string =>
  direct
    ? `${quoteToolName(name)} (a direct tool: call it outside execute_typescript)`
    : quoteToolName(name);

const directToolMessage = (
  verdict: Extract<ScriptNameVerdict, { kind: "direct-tool" }>,
): string => {
  const tool = quoteToolName(verdict.tool);
  const lead =
    verdict.name === verdict.tool
      ? `${tool} is a direct tool, not a script function.`
      : `${quoteToolName(verdict.name)} is not a script function; the direct tool is ${tool}.`;
  const readInstead =
    verdict.readInstead === undefined
      ? ""
      : ` To read inside the script instead, call ${quoteToolName(verdict.readInstead)}.`;
  return `${lead} Call it as its own tool call outside execute_typescript. Do the reads in the script, return the data, then call ${tool} with it.${readInstead}`;
};

/** The line a run adds to its logs when it ran a read in place of `name`. */
const autofixNote = (name: string, target: string): string =>
  `Ran ${quoteToolName(target)} for ${quoteToolName(name)}; use the external_ name in scripts.`;

/**
 * The model-facing answer for a name that is not a script function, or
 * undefined when the guide has nothing better than the script's own error.
 * `run-read` answers here only for a spelling the run could not intercept
 * (the script already failed on it), so it names the function to call.
 */
export const scriptNameMessage = (
  verdict: ScriptNameVerdict,
): string | undefined => {
  switch (verdict.kind) {
    case "run-read": {
      return `${quoteToolName(verdict.name)} is not defined. Call ${quoteToolName(verdict.target)} in scripts.`;
    }
    case "direct-tool": {
      return directToolMessage(verdict);
    }
    case "ambiguous-read": {
      return `${quoteToolName(verdict.name)} matches several script functions. Call one by its full name: ${verdict.candidates.map(quoteToolName).join(", ")}.`;
    }
    case "unavailable": {
      const reason = verdict.reason === undefined ? "" : ` (${verdict.reason})`;
      const next =
        didYouMean(verdict.suggestions.map(suggestionLabel)) ||
        "Continue without it.";
      return `${quoteToolName(verdict.tool)} is not available in this chat${reason}. ${next}`;
    }
    case "near-miss": {
      return `${quoteToolName(verdict.name)} is not defined. ${didYouMean(verdict.suggestions.map(suggestionLabel))}`;
    }
    case "unknown": {
      return undefined;
    }
    default: {
      verdict satisfies never;
      return panic("Unhandled script name verdict");
    }
  }
};

const snakeCase = (name: string): string => name.replaceAll("-", "_");

const capitalized = (word: string): string =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

const camelCase = (name: string): string => {
  const [first = "", ...rest] = snakeCase(name)
    .split("_")
    .filter((word) => word !== "");
  return `${first}${rest.map(capitalized).join("")}`;
};

const pascalCase = (name: string): string => capitalized(camelCase(name));

const READ_FUNCTION_PREFIX = "external_";

/**
 * The spellings a model plausibly writes for each name, which the sandbox
 * predefines so that a call to one is answered even when the script catches
 * the failure. Anything else still reaches the guide through the script's
 * uncaught ReferenceError.
 */
const plausibleSpellings = (catalog: ScriptCallCatalog): string[] => {
  const spellings: string[] = [];
  for (const read of catalog.readFunctions) {
    const bare = read.startsWith(READ_FUNCTION_PREFIX)
      ? read.slice(READ_FUNCTION_PREFIX.length)
      : read;
    spellings.push(
      bare,
      camelCase(bare),
      pascalCase(bare),
      `external${pascalCase(bare)}`,
      `${READ_FUNCTION_PREFIX}${camelCase(bare)}`,
    );
  }
  for (const tool of [
    ...catalog.directTools,
    ...catalog.unavailableTools.keys(),
  ]) {
    spellings.push(snakeCase(tool), camelCase(tool));
  }
  return spellings;
};

const GUIDED_KINDS = new Set<ScriptNameVerdict["kind"]>([
  "run-read",
  "direct-tool",
  "ambiguous-read",
  "unavailable",
]);

const toSandboxVerdict = (verdict: ScriptNameVerdict): SandboxNameVerdict => {
  if (verdict.kind === "run-read") {
    return {
      kind: "run",
      target: verdict.target,
      note: autofixNote(verdict.name, verdict.target),
    };
  }
  const message = scriptNameMessage(verdict);
  return message === undefined
    ? { kind: "none" }
    : { kind: "explain", message };
};

/** The sandbox name guide for one script run over `catalog`. */
export const buildScriptCallGuide = (
  catalog: ScriptCallCatalog,
): SandboxNameGuide => {
  const index = indexCatalog(catalog);
  const own = new Set(catalog.readFunctions);
  const names = [...new Set(plausibleSpellings(catalog))].filter(
    (name) =>
      SANDBOX_IDENTIFIER_PATTERN.test(name) &&
      !own.has(name) &&
      GUIDED_KINDS.has(classifyIndexed(name, index, false).kind),
  );
  return {
    names,
    resolve: (name) => toSandboxVerdict(classifyIndexed(name, index)),
    explainMissing: (name) => scriptNameMessage(classifyIndexed(name, index)),
  };
};
