export const MATTER_REFERENCE_TOKENS = [
  "{SEQ}",
  "{YYYY}",
  "{YY}",
  "{MM}",
] as const;

export type MatterReferenceToken = (typeof MATTER_REFERENCE_TOKENS)[number];

export const DEFAULT_MATTER_NUMBER_PATTERN = "{SEQ}";
export const DEFAULT_MATTER_NUMBER_PADDING = 3;

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const TOKEN_MATCH_SOURCE = {
  "{SEQ}": (padding: number) => `\\d{${Math.max(1, padding)},}`,
  "{YYYY}": () => "\\d{4}",
  "{YY}": () => "\\d{2}",
  "{MM}": () => "(?:0[1-9]|1[0-2])",
} as const satisfies Record<MatterReferenceToken, (padding: number) => string>;

/** Match a rendered reference against an already validated pattern. */
export const matchesMatterReferencePattern = (
  reference: string,
  pattern: string,
  padding: number,
): boolean => {
  let source = escapeRegex(pattern);
  for (const token of MATTER_REFERENCE_TOKENS) {
    const replacement = TOKEN_MATCH_SOURCE[token](padding);
    source = source.replaceAll(escapeRegex(token), () => replacement);
  }
  return new RegExp(`^${source}$`, "u").test(reference);
};

type RenderMatterReferencePatternOptions = {
  now: Date;
  pattern: string;
  sequence: string;
};

/** Render every recognized token from one total token-value map. */
export const renderMatterReferencePattern = ({
  now,
  pattern,
  sequence,
}: RenderMatterReferencePatternOptions): string => {
  const year = String(now.getFullYear());
  const values = {
    "{SEQ}": sequence,
    "{YYYY}": year,
    "{YY}": year.slice(2),
    "{MM}": String(now.getMonth() + 1).padStart(2, "0"),
  } as const satisfies Record<MatterReferenceToken, string>;

  let rendered = pattern;
  for (const token of MATTER_REFERENCE_TOKENS) {
    rendered = rendered.replaceAll(token, () => values[token]);
  }
  return rendered;
};
