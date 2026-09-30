import { Result } from "better-result";

import { ORACLE_VERSION, TEXT_ORACLE_LIMITS, TextOracleError } from "./types";

/** Compatibility glyphs and discretionary hyphens are typography, not omitted text. */
export const normalizeRetentionText = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/\u00ad/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

const frequencies = (units: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const unit of units) {
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  return counts;
};

type MissingUnitsOptions = {
  source: readonly string[];
  output: readonly string[];
};

const missingUnits = ({ source, output }: MissingUnitsOptions) => {
  const available = frequencies(output);
  const missing: string[] = [];
  let matchedCharacters = 0;
  for (const unit of source) {
    const remaining = available.get(unit) ?? 0;
    if (remaining === 0) {
      missing.push(unit);
      continue;
    }
    available.set(unit, remaining - 1);
    matchedCharacters += Array.from(unit).length;
  }
  return { missing, matchedCharacters };
};

/** Includes digits, marks and punctuation; there are no language-specific stop words. */
const wordUnits = (text: string): string[] =>
  text.match(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu) ?? [];

const characterUnits = (text: string): string[] =>
  Array.from(text.replace(/\s/gu, ""));

type RetentionVerdict =
  | { status: "empty_source"; oracleVersion: number }
  | {
      status: "assessed";
      oracleVersion: number;
      retainedRatio: number;
      defect: "text_loss_suspected" | null;
      missingWords: number;
      missingCharacters: number;
      missingSampleHash: string | null;
    };

type CompareRetentionOptions = { source: string; output: string };

/** Occurrence counts stop added headings from compensating for absent source units. */
export const compareRetention = ({
  source,
  output,
}: CompareRetentionOptions) => {
  if (
    source.length > TEXT_ORACLE_LIMITS.textCharacters ||
    output.length > TEXT_ORACLE_LIMITS.textCharacters
  ) {
    return Result.err(
      new TextOracleError({
        reason: "resource_limit",
        message: "Retention text exceeds the character limit",
      }),
    );
  }
  const sourceText = normalizeRetentionText(source);
  const outputText = normalizeRetentionText(output);
  const sourceCharacters = characterUnits(sourceText);
  if (sourceCharacters.length === 0) {
    return Result.ok({
      status: "empty_source",
      oracleVersion: ORACLE_VERSION,
    } as const satisfies RetentionVerdict);
  }
  const words = missingUnits({
    source: wordUnits(sourceText),
    output: wordUnits(outputText),
  });
  const characters = missingUnits({
    source: sourceCharacters,
    output: characterUnits(outputText),
  });
  const missing = words.missing.length > 0 || characters.missing.length > 0;
  const sample = [
    ...words.missing.slice(0, 32),
    ...characters.missing.slice(0, 64),
  ]
    .join("\n")
    .slice(0, 1024);
  return Result.ok({
    status: "assessed",
    oracleVersion: ORACLE_VERSION,
    retainedRatio:
      Math.min(words.matchedCharacters, characters.matchedCharacters) /
      sourceCharacters.length,
    defect: missing ? "text_loss_suspected" : null,
    missingWords: words.missing.length,
    missingCharacters: characters.missing.length,
    missingSampleHash: missing
      ? new Bun.CryptoHasher("sha256").update(sample).digest("hex")
      : null,
  } as const satisfies RetentionVerdict);
};
