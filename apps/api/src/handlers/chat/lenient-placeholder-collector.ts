import { panic } from "better-result";

import { RegexSet } from "@stll/regex-set";
import { escapeRegExp } from "@stll/text-normalize";

const PLACEHOLDER_INNER_TOKEN = /^[A-Z][A-Z0-9_]*$/u;

export type LenientPlaceholderCollector = {
  pattern: RegexSet;
  placeholderByToken: ReadonlyMap<string, string>;
};

export const buildLenientPlaceholderCollector = (
  redactionMap: ReadonlyMap<string, string>,
): LenientPlaceholderCollector | null => {
  const placeholderByToken = new Map<string, string>();
  const bracketed: string[] = [];
  const bracketless: string[] = [];

  for (const key of redactionMap.keys()) {
    const placeholder = key.toWellFormed();
    if (!placeholderByToken.has(placeholder)) {
      placeholderByToken.set(placeholder, key);
      bracketed.push(escapeRegExp(placeholder));
    }

    if (!placeholder.startsWith("[") || !placeholder.endsWith("]")) {
      continue;
    }

    const inner = placeholder.slice(1, -1);
    if (PLACEHOLDER_INNER_TOKEN.test(inner) && !placeholderByToken.has(inner)) {
      placeholderByToken.set(inner, key);
      bracketless.push(escapeRegExp(inner));
    }
  }

  if (bracketed.length === 0 && bracketless.length === 0) {
    return null;
  }

  bracketed.sort((a, b) => b.length - a.length);
  bracketless.sort((a, b) => b.length - a.length);

  const patterns: string[] = [];
  if (bracketed.length > 0) {
    patterns.push(bracketed.join("|"));
  }
  if (bracketless.length > 0) {
    patterns.push(`\\b(?:${bracketless.join("|")})\\b`);
  }

  return {
    pattern: new RegexSet([new RegExp(patterns.join("|"), "gu")], {
      unicodeBoundaries: false,
    }),
    placeholderByToken,
  };
};

export const collectLenientPlaceholders = (
  text: string,
  lenientCollector: LenientPlaceholderCollector,
): Set<string> => {
  const placeholders = new Set<string>();
  for (const match of lenientCollector.pattern.findIter(text.toWellFormed())) {
    const placeholder = lenientCollector.placeholderByToken.get(match.text);
    if (placeholder === undefined) {
      panic("Placeholder matcher returned an unknown token");
    }
    placeholders.add(placeholder);
  }

  return placeholders;
};
