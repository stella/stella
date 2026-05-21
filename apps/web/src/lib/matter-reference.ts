// Source of truth for the token set: apps/api/src/lib/matter-reference.ts.
// Keep RECOGNIZED_TOKENS in sync. Mirror exists here so the UI can validate
// and preview matter references without a network round-trip.

export const DEFAULT_MATTER_NUMBER_PATTERN = "{SEQ}";
export const DEFAULT_MATTER_NUMBER_PADDING = 3;

const TOKEN_REGEX = /\{(SEQ|YYYY|YY|MM)\}/gu;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const tokenToRegex = (token: string, padding: number): string => {
  if (token === "{SEQ}") {
    return `\\d{${Math.max(1, padding)},}`;
  }
  if (token === "{YYYY}") {
    return "\\d{4}";
  }
  if (token === "{YY}") {
    return "\\d{2}";
  }
  if (token === "{MM}") {
    return "(?:0[1-9]|1[0-2])";
  }
  return escapeRegex(token);
};

export const matchesPattern = (
  reference: string,
  pattern: string,
  padding: number,
): boolean => {
  let body = "";
  let lastIndex = 0;
  TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = TOKEN_REGEX.exec(pattern);
  while (match !== null) {
    body += escapeRegex(pattern.slice(lastIndex, match.index));
    body += tokenToRegex(match[0], padding);
    lastIndex = match.index + match[0].length;
    match = TOKEN_REGEX.exec(pattern);
  }
  body += escapeRegex(pattern.slice(lastIndex));

  return new RegExp(`^${body}$`, "u").test(reference);
};

export const previewReference = ({
  pattern,
  padding,
  now = new Date(),
}: {
  pattern: string;
  padding: number;
  now?: Date;
}): string => {
  const yyyy = String(now.getFullYear());
  const yy = yyyy.slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const paddedSeq = "1".padStart(padding, "0");

  return pattern
    .replaceAll("{YYYY}", yyyy)
    .replaceAll("{YY}", yy)
    .replaceAll("{MM}", mm)
    .replaceAll("{SEQ}", paddedSeq);
};
