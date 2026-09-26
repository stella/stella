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
