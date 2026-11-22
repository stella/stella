import { panic } from "better-result";

export const DOCUMENT_NAME_TOKENS = [
  "{date}",
  "{dateCompact}",
  "{matterNumber}",
  "{docType}",
  "{title}",
] as const;

export type DocumentNameToken = (typeof DOCUMENT_NAME_TOKENS)[number];

export const MAX_DOCUMENT_NAME_PATTERN_LENGTH = 128;
const MAX_DOCUMENT_NAME_LENGTH = 200;

const TOKEN_REGEX = /\{[^{}]*\}/gu;
const SEPARATOR_ONLY = /^[\s._-]+$/u;
const SEPARATOR_CHAR = /[\s._-]/u;
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\p{Cc}]+/gu;
const UNSAFE_NAME_CHAR = /[\\/:*?"<>|\p{Cc}]/u;

/** Strip separators from both ends; a linear scan, since a trailing-anchored regex backtracks quadratically. */
const trimSeparators = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && SEPARATOR_CHAR.test(text.charAt(start))) {
    start += 1;
  }
  while (end > start && SEPARATOR_CHAR.test(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(start, end);
};

const isDocumentNameToken = (token: string): token is DocumentNameToken =>
  DOCUMENT_NAME_TOKENS.some((known) => known === token);

/** Why a pattern cannot be saved, or `null` when it can. */
export const documentNamePatternProblem = (pattern: string): string | null => {
  if (pattern.length > MAX_DOCUMENT_NAME_PATTERN_LENGTH) {
    return `Pattern must be at most ${MAX_DOCUMENT_NAME_PATTERN_LENGTH} characters`;
  }
  const literal = pattern.replaceAll(TOKEN_REGEX, "");
  if (/[{}]/u.test(literal)) {
    return "Pattern must not contain unmatched or nested braces";
  }
  if (UNSAFE_NAME_CHAR.test(literal)) {
    return 'Pattern must not contain \\ / : * ? " < > |';
  }
  const tokens = Array.from(pattern.matchAll(TOKEN_REGEX), ([token]) => token);
  const unknown = tokens.find((token) => !isDocumentNameToken(token));
  if (unknown !== undefined) {
    return `Unrecognized token: ${unknown}`;
  }
  if (tokens.length === 0) {
    return "Pattern must contain at least one token";
  }
  return null;
};

export type DocumentNameValues = {
  /** The document's own date, as an ISO calendar date (YYYY-MM-DD). */
  date: string | null;
  matterNumber: string | null;
  docType: string | null;
  title: string | null;
};

type RenderDocumentNameOptions = {
  pattern: string;
  values: DocumentNameValues;
  /** Kept as is, including its dot; empty for a name without one. */
  extension: string;
};

const cleanValue = (value: string | null): string =>
  (value ?? "")
    .replaceAll(UNSAFE_NAME_CHARS, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

const tokenValue = (token: DocumentNameToken, values: DocumentNameValues) => {
  switch (token) {
    case "{date}":
      return cleanValue(values.date);
    case "{dateCompact}":
      return cleanValue(values.date).replaceAll("-", "");
    case "{matterNumber}":
      return cleanValue(values.matterNumber);
    case "{docType}":
      return cleanValue(values.docType);
    case "{title}":
      return cleanValue(values.title);
    default:
      token satisfies never;
      return panic("Unhandled document name token");
  }
};

/**
 * Fill a validated pattern. A token without a value is dropped with the
 * separator before it (or after it, at the start), so a missing date never
 * leaves `_-` or `unknown` in the name. Returns `null` when nothing is left,
 * so the caller keeps the name it had.
 *
 * Example: "{date}_{matterNumber}_{docType}_{title}" with no date and no type
 * gives "2026-042_Share purchase agreement.pdf".
 */
export const renderDocumentName = ({
  pattern,
  values,
  extension,
}: RenderDocumentNameOptions): string | null => {
  const parts = pattern.split(/(\{[^{}]*\})/u).filter((part) => part !== "");
  const kept: string[] = [];
  let dropNextSeparator = false;
  for (const part of parts) {
    if (!isDocumentNameToken(part)) {
      if (dropNextSeparator && SEPARATOR_ONLY.test(part)) {
        dropNextSeparator = false;
        continue;
      }
      dropNextSeparator = false;
      kept.push(part);
      continue;
    }
    const value = tokenValue(part, values);
    if (value !== "") {
      kept.push(value);
      continue;
    }
    const previous = kept.at(-1);
    if (previous !== undefined && SEPARATOR_ONLY.test(previous)) {
      kept.pop();
    } else if (previous === undefined) {
      dropNextSeparator = true;
    }
  }
  const stem = trimSeparators(kept.join("").replaceAll(/\s{2,}/gu, " "))
    .slice(0, MAX_DOCUMENT_NAME_LENGTH)
    .trim();
  return stem === "" ? null : `${stem}${extension}`;
};
