/**
 * Legal form detection for company/organization names.
 *
 * Loads legal form suffixes from config/legal-forms.json,
 * auto-escapes them for regex, and detects company names
 * by finding the suffix and extending backwards to capture
 * preceding capitalised words.
 *
 * Data-driven: add a new country or form by editing the
 * JSON config. No code changes needed.
 */

import legalFormsData from "../config/legal-forms.json";
import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

// Character classes for European capitalised words
const UPPER = "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÄÖÜÀÂÆÇÈÊËÎÏÔÙÛŸÑ\\u0130";
const LOWER = "a-záčďéěíňóřšťúůýžäöüßàâæçèêëîïôùûÿñ\\u0131";
// Match capitalised ("Praha"), all-caps ("RELAKA"), or
// mixed ("McDonald") — at least 2 chars
const CAP_WORD = `[${UPPER}][${LOWER}${UPPER}]+`;

/**
 * Escape a legal form string for regex, with flexible spacing.
 * Inserts optional whitespace after dots and around spaces,
 * so "s.r.o." matches "s. r. o.", "s.r.o.", "s . r . o.", etc.
 */
const escapeForRegex = (form: string): string =>
  form
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    .replace(/\\\./g, "\\.\\s*");

/**
 * Short forms (2-3 chars, no dots) need stricter matching
 * to avoid false positives on common abbreviations.
 */
const isShortForm = (form: string): boolean =>
  form.replace(/[.\s]/g, "").length <= 3 && !form.includes(" ");

/** Collect all forms from the JSON, deduplicate. */
const allForms: string[] = [];
const seen = new Set<string>();

for (const forms of Object.values(legalFormsData as Record<string, string[]>)) {
  for (const form of forms) {
    const key = form.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      allForms.push(form);
    }
  }
}

const longForms = allForms.filter((f) => !isShortForm(f));
const shortForms = allForms.filter(isShortForm);

/**
 * Build regex: 1-5 capitalised words + legal form suffix.
 * Long forms match freely; short forms require the suffix
 * to follow a capitalised word or comma (not standalone).
 */
const buildPattern = (
  forms: string[],
  requireCapBefore: boolean,
): RegExp | null => {
  if (forms.length === 0) {
    return null;
  }

  // Sort longest first to prevent partial matches
  const sorted = forms.toSorted((a, b) => b.length - a.length);
  const alt = sorted.map(escapeForRegex).join("|");

  const prefix = `(?:${CAP_WORD})(?:[\\s&,.-]{1,4}(?:${CAP_WORD})){0,4}`;

  const separator = requireCapBefore ? `(?:\\s+|,\\s*)` : `\\s+`;

  return new RegExp(`${prefix}${separator}(?:${alt})(?![${LOWER}])`, "g");
};

const LONG_RE = buildPattern(longForms, false);
const SHORT_RE = buildPattern(shortForms, true);

/**
 * Detect organization entities by legal form suffixes.
 *
 * Scans the full text for known legal form patterns and
 * extends backwards to capture the preceding capitalised
 * company name words.
 */
export const detectLegalFormEntities = (fullText: string): Entity[] => {
  const results: Entity[] = [];

  for (const re of [LONG_RE, SHORT_RE]) {
    if (!re) {
      continue;
    }
    re.lastIndex = 0;

    for (
      let match = re.exec(fullText);
      match !== null;
      match = re.exec(fullText)
    ) {
      const text = match[0];
      if (text.length < 5) {
        continue;
      }

      results.push({
        start: match.index,
        end: match.index + text.length,
        label: "organization",
        text,
        score: 0.9,
        source: DETECTION_SOURCES.LEGAL_FORM,
      });
    }
  }

  return results;
};
