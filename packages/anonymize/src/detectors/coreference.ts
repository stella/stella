import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

/**
 * Czech surname declension patterns.
 * Male surnames ending in consonant clusters decline
 * with standard suffixes. Female "-ová" surnames
 * decline differently.
 */
const CZECH_MALE_ENDINGS_RE = /(?:ák|ek|ík|ý|ský|cký)$/;
const CZECH_FEMALE_ENDINGS_RE = /(?:ová|á)$/;

/**
 * Suffixes that, when stripped from a word, may yield
 * the base (nominative) form of a Czech male surname.
 * Used for reverse matching: given "Novákovi" in text,
 * strip "-ovi" to recover "Novák" and check if it was
 * already detected.
 */
const CZECH_INFLECTION_SUFFIXES = [
  "ovi", // dative
  "em", // instrumental (general)
  "om", // instrumental (some consonant stems)
  "ov", // possessive (Novákův -> stem Novák)
  "a", // genitive
  "u", // accusative/locative
] as const;

/**
 * Try to recover the base form of a Czech surname by
 * stripping known inflection suffixes. Returns all
 * plausible base forms (caller checks against known
 * entities).
 */
export const stripCzechInflection = (word: string): string[] => {
  const bases: string[] = [];
  for (const suffix of CZECH_INFLECTION_SUFFIXES) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      bases.push(word.slice(0, -suffix.length));
    }
  }
  return bases;
};

/**
 * Generate declined variants of a single Czech word (name).
 * Returns the base form plus common case forms.
 *
 * Male: -ovi (dative), -em (instrumental),
 *       -om (instrumental, some stems),
 *       -ov (possessive), -a (genitive),
 *       -u (accusative)
 * Female: -ou (instrumental), -é (dative/locative)
 */
const declineSingleWord = (word: string): string[] => {
  const variants: string[] = [word];

  if (CZECH_FEMALE_ENDINGS_RE.test(word)) {
    if (word.endsWith("ová")) {
      const stem = word.slice(0, -3);
      variants.push(`${stem}ovou`); // instrumental
      variants.push(`${stem}ové`); // dative/locative
    } else if (word.endsWith("á")) {
      const stem = word.slice(0, -1);
      variants.push(`${stem}ou`); // instrumental
      variants.push(`${stem}é`); // dative/locative
    }
  } else if (CZECH_MALE_ENDINGS_RE.test(word)) {
    if (word.endsWith("ek")) {
      // e.g., Novacek -> Novack- (fleeting e)
      const stem = word.slice(0, -2);
      variants.push(`${stem}kovi`); // dative
      variants.push(`${stem}kem`); // instrumental
      variants.push(`${stem}ka`); // genitive
      variants.push(`${stem}ku`); // accusative
      variants.push(`${stem}kov`); // possessive
    } else if (word.endsWith("ý")) {
      const stem = word.slice(0, -1);
      variants.push(`${stem}ému`); // dative
      variants.push(`${stem}ým`); // instrumental
      variants.push(`${stem}ého`); // genitive
    } else if (word.endsWith("ský") || word.endsWith("cký")) {
      const stem = word.slice(0, -1);
      variants.push(`${stem}ému`); // dative
      variants.push(`${stem}ým`); // instrumental
      variants.push(`${stem}ého`); // genitive
    } else {
      // General male consonant ending (ák, ík, etc.)
      variants.push(`${word}ovi`); // dative
      variants.push(`${word}em`); // instrumental
      variants.push(`${word}om`); // instrumental (alt)
      variants.push(`${word}ov`); // possessive
      variants.push(`${word}a`); // genitive
      variants.push(`${word}u`); // accusative
    }
  } else if (word.length > 3 && /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(word)) {
    // General consonant-ending male name not matching
    // specific patterns (e.g., foreign names like
    // "Nguyen", "Patrik"). Apply standard suffixes.
    variants.push(`${word}ovi`); // dative
    variants.push(`${word}em`); // instrumental
    variants.push(`${word}a`); // genitive
    variants.push(`${word}u`); // accusative
  }

  return variants;
};

/**
 * Generate declined variants of a Czech name (single or
 * multi-word). For multi-word names like "Patrik Nguyen",
 * generates:
 * - Individual word variants: "Patrikem", "Nguyenem"
 * - Combined full-name variants: "Patrikem Nguyenem"
 *   (instrumental), "Patrika Nguyena" (genitive), etc.
 */
export const generateCzechNameVariants = (name: string): string[] => {
  const words = name.split(/\s+/);

  // Single word: delegate directly
  if (words.length === 1) {
    return declineSingleWord(name);
  }

  // Multi-word name: generate per-word variants and
  // combine corresponding case forms across words.
  const perWord = words.map((w) => declineSingleWord(w));
  const variants = new Set<string>([name]);

  // Add individual word variants (standalone)
  for (const wordVariants of perWord) {
    for (const v of wordVariants) {
      variants.add(v);
    }
  }

  // Combine full-name declined forms. Each word's
  // variant array starts with the nominative at [0],
  // then case forms. Pair corresponding indices to
  // build "Patrikem Nguyenem", "Patrika Nguyena", etc.
  const maxLen = Math.max(...perWord.map((v) => v.length));
  for (let i = 1; i < maxLen; i++) {
    const combined = perWord.map((wv) => wv[i] ?? wv[0] ?? "").join(" ");
    if (combined !== name) {
      variants.add(combined);
    }
  }

  return [...variants];
};

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

    // Generate Czech declined name variants for person
    // entities so that "Novákovi" matches when "Novák"
    // was detected by NER.
    if (entity.label === "person") {
      const words = entity.text.trim().split(/\s+/);
      for (const word of words) {
        // Skip short words and title tokens (e.g., "Ing.", "Dr.")
        if (word.length < 3 || word.endsWith(".")) {
          continue;
        }
        const variants = generateCzechNameVariants(word);
        for (const variant of variants) {
          if (variant === word) {
            continue;
          }
          const key = `${variant.toLowerCase()}::${entity.label}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);

          terms.push({
            alias: variant,
            label: entity.label,
            definitionStart: entity.start,
          });
        }
      }
    }
  }

  // Reverse inflection pass: scan for words in text that
  // strip back to a known entity word. E.g., "Novákovi"
  // in text -> strip "-ovi" -> "Novák" -> known entity.
  const knownPersonWords = new Set<string>();
  for (const entity of entities) {
    if (entity.label === "person") {
      for (const w of entity.text.trim().split(/\s+/)) {
        if (w.length >= 3) {
          knownPersonWords.add(w);
        }
      }
    }
  }

  if (knownPersonWords.size > 0) {
    // Find capitalised words in text that might be
    // inflected forms of known names
    const wordRe = /\b[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]{3,}\b/g;
    wordRe.lastIndex = 0;
    for (let m = wordRe.exec(fullText); m !== null; m = wordRe.exec(fullText)) {
      const word = m[0];
      if (knownPersonWords.has(word)) {
        continue; // already a known base form
      }
      const bases = stripCzechInflection(word);
      for (const base of bases) {
        if (knownPersonWords.has(base)) {
          const key = `${word.toLowerCase()}::person`;
          if (seen.has(key)) {
            break;
          }
          seen.add(key);
          terms.push({
            alias: word,
            label: "person",
            definitionStart: m.index,
          });
          break;
        }
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
