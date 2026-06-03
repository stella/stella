import { panic } from "better-result";

const CASE_LAW_DECISION_SLUG_MAX_LENGTH = 256;

const trimSlugHyphens = (value: string): string => {
  let start = 0;
  while (value.at(start) === "-") {
    start += 1;
  }

  let end = value.length;
  while (end > start && value.at(end - 1) === "-") {
    end -= 1;
  }

  return value.slice(start, end);
};

const fitSlug = (baseSlug: string, suffix?: number): string => {
  const suffixText = suffix === undefined ? "" : `-${suffix}`;
  const maxBaseLength = CASE_LAW_DECISION_SLUG_MAX_LENGTH - suffixText.length;
  const trimmed = trimSlugHyphens(baseSlug.slice(0, maxBaseLength));
  return `${trimmed || "unknown"}${suffixText}`;
};

export const createCaseLawDecisionSlug = (caseNumber: string): string => {
  const slug = trimSlugHyphens(
    caseNumber
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/gu, "-"),
  );

  return fitSlug(slug || "unknown");
};

export const createAvailableCaseLawDecisionSlug = (
  baseSlug: string,
  existingSlugs: readonly (string | null)[],
): string => {
  const used = new Set(existingSlugs.filter((slug) => slug !== null));
  const normalizedBase = fitSlug(baseSlug);

  if (!used.has(normalizedBase)) {
    return normalizedBase;
  }

  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = fitSlug(normalizedBase, suffix);
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return panic("No available case-law decision slug");
};
