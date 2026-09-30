import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import type { TanStackAIProvider } from "@stll/ai-catalog";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { WIRE_PROMPT_SECTIONS } from "@/api/tests/helpers/replayed-harness-model";

// What a chat request's cached prefix is on the wire, and the committed
// budgets it is held to: the tokens of each surface's stable prefix (a
// ratchet) and each tool's share of it (a per-tool budget with written
// exceptions). Both are read from the request bodies the provider SDKs wrote
// in `provider-request-cache.integration.test.ts`.

// --- Reading a request --------------------------------------------------------

/** The keys a provider SDK writes a cache marker under. */
const CACHE_MARKER_KEYS: ReadonlySet<string> = new Set([
  "cacheControl",
  "cache_control",
  "cachePoint",
]);

/** Every cache marker in `body` (a set, non-null value), by JSON path. */
export const cacheMarkersOf = (body: unknown): string[] => {
  const found: string[] = [];
  const visit = (value: unknown, at: string) => {
    if (isUnknownArray(value)) {
      for (const [index, item] of value.entries()) {
        visit(item, `${at}[${String(index)}]`);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (CACHE_MARKER_KEYS.has(key)) {
        if (child !== null && child !== undefined) {
          found.push(`${at}.${key}`);
        }
        continue;
      }
      visit(child, `${at}.${key}`);
    }
  };
  visit(body, "body");
  return found;
};

/** The system prompt's blocks as the provider receives them, in order. A
 *  provider that sends it as the first message holds it there. */
const systemEntriesOf = (
  provider: TanStackAIProvider,
  body: Record<string, unknown>,
): readonly unknown[] => {
  const sections = WIRE_PROMPT_SECTIONS[provider](body);
  if (provider !== "mistral" && provider !== "openrouter") {
    return sections.system;
  }
  const first = sections.messages.at(0);
  if (!isRecord(first) || first["role"] !== "system") {
    return [];
  }
  const content = first["content"];
  return isUnknownArray(content) ? content : [content];
};

/** The text of one system block, whichever shape its provider gives it. */
const blockText = (block: unknown): string => {
  if (typeof block === "string") {
    return block;
  }
  if (!isRecord(block)) {
    return "";
  }
  if (typeof block["text"] === "string") {
    return block["text"];
  }
  const parts = block["parts"];
  return isUnknownArray(parts) ? parts.map(blockText).join("") : "";
};

/** Each system block's text and whether a cache marker ends it. */
export const systemBlocksOf = (
  provider: TanStackAIProvider,
  body: Record<string, unknown>,
): { marked: boolean; text: string }[] =>
  systemEntriesOf(provider, body).map((block) => ({
    marked: cacheMarkersOf(block).length > 0,
    text: blockText(block),
  }));

/** The system prompt as one string. */
export const systemTextOf = (
  provider: TanStackAIProvider,
  body: Record<string, unknown>,
): string =>
  systemBlocksOf(provider, body)
    .map(({ text }) => text)
    .join("");

/** Each tool an Anthropic request declares, as the provider receives it
 *  (one entry per tool, named at its top level). */
export const anthropicToolEntriesOf = (
  body: Record<string, unknown>,
): { name: string; wire: unknown }[] =>
  WIRE_PROMPT_SECTIONS.anthropic(body).tools.flatMap((tool) =>
    isRecord(tool) && typeof tool["name"] === "string"
      ? [{ name: tool["name"], wire: tool }]
      : [],
  );

/** The tools section of a request, as the provider receives it. */
export const toolsSectionOf = (
  provider: TanStackAIProvider,
  body: Record<string, unknown>,
): readonly unknown[] => WIRE_PROMPT_SECTIONS[provider](body).tools;

/** How many leading characters `a` and `b` share. */
export const commonPrefixLength = (a: string, b: string): number => {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) {
    at += 1;
  }
  return at;
};

// --- Sizes ----------------------------------------------------------------------

/**
 * Estimated model tokens of a wire value: its string values under a
 * `description` key count as prose, everything else of its JSON as structure.
 * The ratios are the ones `scripts/mcp-surface-baseline.ts` calibrated against
 * Anthropic `count_tokens` (prose 3, JSON 2.4 characters per token); the
 * estimate is a size for budgets, not a billing count.
 */
const CHARS_PER_TOKEN = { json: 2.4, prose: 3 } as const;

export const estimatedTokens = ({
  json = "",
  prose = "",
}: {
  json?: string;
  prose?: string;
}): number =>
  Math.round(json.length / CHARS_PER_TOKEN.json) +
  Math.round(prose.length / CHARS_PER_TOKEN.prose);

/** `estimatedTokens` of a wire value, its descriptions read as prose. */
export const estimatedWireTokens = (value: unknown): number => {
  const descriptions: string[] = [];
  const visit = (inner: unknown) => {
    if (isUnknownArray(inner)) {
      for (const item of inner) {
        visit(item);
      }
    } else if (isRecord(inner)) {
      for (const [key, child] of Object.entries(inner)) {
        if (key === "description" && typeof child === "string") {
          descriptions.push(child);
        } else {
          visit(child);
        }
      }
    }
  };
  visit(value);
  const prose = descriptions.join("");
  const json = JSON.stringify(value);
  return estimatedTokens({
    json: json.slice(0, Math.max(0, json.length - prose.length)),
    prose,
  });
};

// --- The committed budgets ------------------------------------------------------

const BASELINE_FILE = path.resolve(
  import.meta.dir,
  "../fixtures/provider-request-schemas/chat-prompt-baseline.json",
);

/** Rewrites the stable-prefix ratchet from what the conversations sent,
 *  appending an entry with the given reason. Never in CI. */
const UPDATE_CHAT_PROMPT_BASELINE_ENV = "UPDATE_CHAT_PROMPT_BASELINE";

const ratchetEntrySchema = v.strictObject({
  reason: v.pipe(v.string(), v.trim(), v.minLength(1)),
  tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const baselineSchema = v.strictObject({
  /**
   * Each chat surface's stable prefix (tools, then the static and
   * organization layers of the system prompt), per provider and tool
   * surface, as an append-only history: the last entry is the budget, and
   * every entry says why the prefix moved.
   */
  stablePrefixTokens: v.record(v.string(), v.array(ratchetEntrySchema)),
  /** The size one tool may add to the prefix without a written reason. */
  toolTokenBudget: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** Why each tool over the budget needs its size. */
  toolsOverBudget: v.record(
    v.string(),
    v.pipe(v.string(), v.trim(), v.minLength(1)),
  ),
});

type ChatPromptBaseline = v.InferOutput<typeof baselineSchema>;

export const readChatPromptBaseline = (): ChatPromptBaseline =>
  v.parse(baselineSchema, JSON.parse(readFileSync(BASELINE_FILE, "utf-8")));

/** The reason an update run records, or null when this run only checks. */
export const chatPromptBaselineUpdateReason = (): string | null => {
  const reason = process.env[UPDATE_CHAT_PROMPT_BASELINE_ENV];
  if (reason === undefined || reason.trim() === "") {
    return null;
  }
  if (process.env["CI"] !== undefined && process.env["CI"] !== "") {
    return panic("CI checks the chat prompt baseline; it never updates it");
  }
  return reason.trim();
};

/**
 * A stable prefix may move this far from its budget, in either direction,
 * before the check fails: a reworded sentence needs no entry, a new tool or
 * section does. Shrinking past it fails too, so a saving is locked in rather
 * than spent later unreviewed.
 */
const toleranceOf = (tokens: number): number =>
  Math.max(50, Math.round(tokens * 0.005));

/** How `measured` departs from the committed budget, as findings. */
export const findStablePrefixDrift = ({
  baseline,
  key,
  measured,
}: {
  baseline: ChatPromptBaseline;
  key: string;
  measured: number;
}): string[] => {
  const budget = baseline.stablePrefixTokens[key]?.at(-1)?.tokens;
  const update = `re-run with ${UPDATE_CHAT_PROMPT_BASELINE_ENV}="<why it moved>"`;
  if (budget === undefined) {
    return [`${key}: no stable-prefix budget committed; ${update}`];
  }
  if (measured > budget + toleranceOf(budget)) {
    return [
      `${key}: the stable prefix grew from ${String(budget)} to ${String(measured)} estimated tokens; if that is intended, ${update}`,
    ];
  }
  if (measured < budget - toleranceOf(budget)) {
    return [
      `${key}: the stable prefix shrank from ${String(budget)} to ${String(measured)} estimated tokens; lock the saving in: ${update}`,
    ];
  }
  return [];
};

/** Appends `measured` to every drifted key's history, with `reason`. */
export const writeStablePrefixTokens = ({
  measured,
  reason,
}: {
  measured: ReadonlyMap<string, number>;
  reason: string;
}) => {
  const baseline = readChatPromptBaseline();
  const next: Record<string, { reason: string; tokens: number }[]> = {
    ...baseline.stablePrefixTokens,
  };
  for (const [key, tokens] of measured) {
    const history = next[key] ?? [];
    if (findStablePrefixDrift({ baseline, key, measured: tokens }).length > 0) {
      next[key] = [...history, { reason, tokens }];
    }
  }
  const ordered = Object.fromEntries(
    Object.keys(next)
      .toSorted()
      .map((key) => [key, next[key]]),
  );
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ ...baseline, stablePrefixTokens: ordered }, null, 2)}\n`,
  );
};
