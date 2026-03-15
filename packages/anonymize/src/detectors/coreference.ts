import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

/**
 * Patterns for extracting defined-term aliases in
 * legal documents. Captures the alias between quotation
 * marks following a definitional phrase.
 *
 * Supports Czech, German, English, and Slovak conventions.
 */
const DEFINITION_PATTERNS: readonly {
  pattern: RegExp;
  language: string;
}[] = [
  // Czech: (dale jen "X") or (dale jen 'X') or (dale jen "X")
  {
    pattern: /\(dále\s+jen\s+[„"'‚]([^"'""]+)[""']\)/gi,
    language: "cs",
  },
  // Czech: dale jen "X" without parens
  {
    pattern: /dále\s+jen\s+[„"'‚]([^"'""]+)[""']/gi,
    language: "cs",
  },
  // German: (nachfolgend "X") or (im Folgenden "X")
  {
    pattern: /\((?:nachfolgend|im\s+Folgenden)\s+[„"'‚]([^"'""]+)[""']\)/gi,
    language: "de",
  },
  // German: nachfolgend "X" without parens
  {
    pattern: /(?:nachfolgend|im\s+Folgenden)\s+[„"'‚]([^"'""]+)[""']/gi,
    language: "de",
  },
  // English: (hereinafter "X") or (the "X")
  {
    pattern: /\((?:hereinafter|the)\s+["'"']([^"'"']+)["'"']\)/gi,
    language: "en",
  },
  // English: hereinafter referred to as "X"
  {
    pattern: /hereinafter\s+(?:referred\s+to\s+as\s+)?["'"']([^"'"']+)["'"']/gi,
    language: "en",
  },
  // Slovak: (dalej len "X")
  {
    pattern: /\(ďalej\s+len\s+[„"'‚]([^"'""]+)[""']\)/gi,
    language: "sk",
  },
];

const SEARCH_WINDOW = 200;

type DefinedTerm = {
  alias: string;
  label: string;
  /** Position of the definition in the source text */
  definitionStart: number;
};

/**
 * Scan for defined-term patterns near known entities.
 *
 * Legal documents universally follow:
 *   "Dr. Heinrich Muller (hereinafter 'the Seller')..."
 *
 * After NER detects the entity, this function scans for
 * definitional patterns within +/-200 chars and extracts
 * the alias. Returns alias + label pairs that can be added
 * to the gazetteer for a full-text re-scan.
 */
export const extractDefinedTerms = (
  fullText: string,
  entities: Entity[],
): DefinedTerm[] => {
  const terms: DefinedTerm[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    const windowStart = Math.max(0, entity.start - SEARCH_WINDOW);
    const windowEnd = Math.min(fullText.length, entity.end + SEARCH_WINDOW);
    const window = fullText.slice(windowStart, windowEnd);

    for (const { pattern } of DEFINITION_PATTERNS) {
      pattern.lastIndex = 0;

      for (
        let match = pattern.exec(window);
        match !== null;
        match = pattern.exec(window)
      ) {
        const alias = match[1]?.trim();
        if (!alias || alias.length < 2) {
          continue;
        }

        const key = `${alias.toLowerCase()}::${entity.label}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        terms.push({
          alias,
          label: entity.label,
          definitionStart: windowStart + match.index,
        });
      }
    }
  }

  return terms;
};

/**
 * Find all occurrences of defined-term aliases in the
 * full text. Returns Entity spans for each match.
 *
 * Simple string search (no fuzzy matching); defined terms
 * are typically exact in legal documents.
 */
export const findCoreferenceSpans = (
  fullText: string,
  terms: DefinedTerm[],
): Entity[] => {
  const results: Entity[] = [];

  for (const term of terms) {
    let searchFrom = 0;
    while (searchFrom < fullText.length) {
      const idx = fullText.indexOf(term.alias, searchFrom);
      if (idx === -1) {
        break;
      }

      results.push({
        start: idx,
        end: idx + term.alias.length,
        label: term.label,
        text: term.alias,
        score: 0.95,
        source: DETECTION_SOURCES.COREFERENCE,
      });

      searchFrom = idx + term.alias.length;
    }
  }

  return results;
};
