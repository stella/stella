import type { Entity } from "../types";

const TEMPLATE_PLACEHOLDER_RE = /^(?:\.{3,}|_{3,}|\[[\w\s]+\]|\{[\w\s]+\})$/;
// Section/clause numbers: "s 3", "3.2.1", "12." but NOT
// long digit strings like ICO "12345678" or account numbers
const SECTION_NUMBER_RE = /^(?:§\s*)?\d{1,4}(?:\.\d{1,4})*\.?$/;
const STANDALONE_YEAR_RE = /^(?:19|20)\d{2}$/;

/**
 * Generic role terms that should not be treated as PII.
 * Lowercased for comparison.
 */
const GENERIC_ROLES = new Set([
  "employee",
  "employer",
  "buyer",
  "seller",
  "landlord",
  "tenant",
  "lender",
  "borrower",
  "company",
  "contractor",
  "client",
  "customer",
  "supplier",
  "vendor",
  "party",
  "parties",
  "licensor",
  "licensee",
  "guarantor",
  // Czech
  "zaměstnanec",
  "zaměstnavatel",
  "kupující",
  "prodávající",
  "pronajímatel",
  "nájemce",
  "věřitel",
  "dlužník",
  "společnost",
  "zhotovitel",
  "objednatel",
  "strana",
  "strany",
  // German
  "arbeitnehmer",
  "arbeitgeber",
  "käufer",
  "verkäufer",
  "vermieter",
  "mieter",
  "darlehensgeber",
  "darlehensnehmer",
  "gesellschaft",
  "auftragnehmer",
  "auftraggeber",
]);

/**
 * Filter out entities that are likely false positives:
 * template placeholders, clause/section numbers,
 * standalone years, and generic legal role terms.
 *
 * Runs as a post-processing step after all detection
 * layers have merged.
 */
export const filterFalsePositives = (entities: Entity[]): Entity[] => {
  const filtered: Entity[] = [];

  for (const entity of entities) {
    const trimmed = entity.text.trim();

    if (TEMPLATE_PLACEHOLDER_RE.test(trimmed)) {
      continue;
    }
    if (SECTION_NUMBER_RE.test(trimmed)) {
      continue;
    }
    if (STANDALONE_YEAR_RE.test(trimmed)) {
      continue;
    }

    if (
      (entity.label === "person" || entity.label === "organization") &&
      GENERIC_ROLES.has(trimmed.toLowerCase())
    ) {
      continue;
    }

    filtered.push(entity);
  }

  return filtered;
};
