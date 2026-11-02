/**
 * Which message keys the source code never names. A key counts as used when a
 * source file holds, as a string literal:
 *
 * - the full key (`t("common.cancel")`, a `TranslationKey` map entry);
 * - a namespace passed to a scoped translator and the rest of the key
 *   (`useTranslations("knowledge.agentSkills")` then `tSkills("importTitle")`);
 * - a template prefix the key extends (`` t(`chat.skills.scope.${scope}`) ``),
 *   on its own or after a namespace in the same file.
 *
 * The match is textual, so it errs towards "used": a key it cannot see used is
 * almost always dead. Keys it reports while still used (built some other way)
 * are grandfathered in the check baseline, which only ever shrinks.
 */

// Literal shapes, each scanned on its own so a quote of one kind never hides a
// literal of another: "…", '…', and a whole template literal `…`.
const LITERAL_PATTERNS = [
  /"([^"\\\n]*)"/gu,
  /'([^'\\\n]*)'/gu,
  /`([^`\\$]*)`/gu,
] as const;
// A template literal whose static head ends at an interpolation: `a.b.${`.
const TEMPLATE_PREFIX = /`([^`\\$]*)\$\{/gu;

type SourceUsage = {
  literals: Set<string>;
  templatePrefixes: string[];
};

const readSourceUsage = (source: string): SourceUsage => {
  const literals = new Set<string>();
  for (const pattern of LITERAL_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      if (value !== undefined && value.length > 0) {
        literals.add(value);
      }
    }
  }
  const templatePrefixes: string[] = [];
  for (const match of source.matchAll(TEMPLATE_PREFIX)) {
    const prefix = match[1];
    if (prefix !== undefined && prefix.length > 0) {
      templatePrefixes.push(prefix);
    }
  }
  return { literals, templatePrefixes };
};

const isUsedIn = (key: string, { literals, templatePrefixes }: SourceUsage) => {
  if (literals.has(key)) {
    return true;
  }
  if (templatePrefixes.some((prefix) => key.startsWith(prefix))) {
    return true;
  }
  const segments = key.split(".");
  for (let split = 1; split < segments.length; split += 1) {
    const namespace = segments.slice(0, split).join(".");
    if (!literals.has(namespace)) {
      continue;
    }
    const rest = segments.slice(split).join(".");
    if (
      literals.has(rest) ||
      templatePrefixes.some((prefix) => rest.startsWith(prefix))
    ) {
      return true;
    }
  }
  return false;
};

/** The keys, in order, that no source names. */
export const findUnusedKeys = (
  keys: readonly string[],
  sources: readonly string[],
): string[] => {
  const usages = sources.map(readSourceUsage);
  return keys.filter((key) => !usages.some((usage) => isUsedIn(key, usage)));
};

const quoted = (literal: string): string[] => [
  `"${literal}"`,
  `'${literal}'`,
  `\`${literal}\``,
];

/**
 * The text on a line that names `key` in a file, by the rules of isUsedIn,
 * except that a template prefix must end at a key segment: `` `a${x}` `` says
 * nothing about which message a line shows, though it keeps a key from being
 * reported unused.
 */
const usageNeedles = (key: string, usage: SourceUsage): string[] => {
  const needles: string[] = [];
  if (usage.literals.has(key)) {
    needles.push(...quoted(key));
  }
  const segmentPrefixes = usage.templatePrefixes.filter((prefix) =>
    prefix.endsWith("."),
  );
  for (const prefix of segmentPrefixes) {
    if (key.startsWith(prefix)) {
      needles.push(`\`${prefix}\${`);
    }
  }
  const segments = key.split(".");
  for (let split = 1; split < segments.length; split += 1) {
    if (!usage.literals.has(segments.slice(0, split).join("."))) {
      continue;
    }
    const rest = segments.slice(split).join(".");
    if (usage.literals.has(rest)) {
      needles.push(...quoted(rest));
    }
    for (const prefix of segmentPrefixes) {
      if (rest.startsWith(prefix)) {
        needles.push(`\`${prefix}\${`);
      }
    }
  }
  return needles;
};

export type SourceFile = { path: string; text: string };
export type KeyUsage = { path: string; line: number; code: string };

type FindKeyUsagesOptions = {
  keys: readonly string[];
  files: readonly SourceFile[];
};

/** For each key, the source lines that name it, as findUnusedKeys counts a use. */
export const findKeyUsages = ({
  keys,
  files,
}: FindKeyUsagesOptions): Map<string, KeyUsage[]> => {
  const indexed = files.map((file) => ({
    ...file,
    usage: readSourceUsage(file.text),
    lines: file.text.split("\n"),
  }));
  const usages = new Map<string, KeyUsage[]>();
  for (const key of keys) {
    const found: KeyUsage[] = [];
    for (const file of indexed) {
      const needles = usageNeedles(key, file.usage);
      if (needles.length === 0) {
        continue;
      }
      for (const [index, line] of file.lines.entries()) {
        if (needles.some((needle) => line.includes(needle))) {
          found.push({ path: file.path, line: index + 1, code: line.trim() });
        }
      }
    }
    usages.set(key, found);
  }
  return usages;
};

type UnusedKeysBaselineAfterOptions = {
  baseline: readonly string[];
  unused: readonly string[];
};

/**
 * The unused-key baseline after a refresh: the grandfathered keys that are
 * still unused. A newly unused key is never added; delete it instead.
 */
export const unusedKeysBaselineAfter = ({
  baseline,
  unused,
}: UnusedKeysBaselineAfterOptions): string[] => {
  const stillUnused = new Set(unused);
  return baseline.filter((key) => stillUnused.has(key)).toSorted();
};
