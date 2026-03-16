import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

const TEMPLATE_PLACEHOLDER_RE = /^(?:\.{3,}|_{3,}|\[[\w\s]+\]|\{[\w\s]+\})$/;
// Section/clause numbers: "s 3", "3.2.1", "12." but NOT
// long digit strings like ICO "12345678" or account numbers
const SECTION_NUMBER_RE = /^(?:§\s*)?\d{1,4}(?:\.\d{1,4})*\.?$/;
const STANDALONE_YEAR_RE = /^(?:19|20)\d{2}$/;

/**
 * Legal references that NER sometimes misidentifies as
 * named entities: "no. 47335/06", "Article 6", "§ 3".
 */
const LEGAL_REFERENCE_RE =
  /^(?:\(?(?:no|nr|app|case)\.?\s*\d|(?:art(?:icle)?|§|sec(?:tion)?|para(?:graph)?|rule|annex)\.?\s*\d)/i;

const MIN_NER_TEXT_LENGTH = 3;

/**
 * Structured labels where NER output must look like the
 * claimed format. Prevents "Smith called" being labelled
 * as a phone number.
 */
const STRUCTURED_LABELS = new Set([
  "phone number",
  "email address",
  "iban",
  "bank account number",
  "credit card number",
  "tax identification number",
  "identity card number",
  "registration number",
]);

const PHONE_LIKE_RE = /(?:\+?\d[\d\s\-()]{6,}|\(\d{2,}\)\s*\d)/;
const EMAIL_LIKE_RE = /\S+@\S+\.\S+/;
const IBAN_LIKE_RE = /^[A-Z]{2}\d{2}[\sA-Z0-9]{10,}/i;
const NUMERIC_ID_RE = /\d{4,}/;

/**
 * Validate that NER-sourced structured entities actually
 * look like their claimed label.
 */
const looksLikeStructuredLabel = (label: string, text: string): boolean => {
  if (label === "phone number") {
    return PHONE_LIKE_RE.test(text);
  }
  if (label === "email address") {
    return EMAIL_LIKE_RE.test(text);
  }
  if (label === "iban") {
    return IBAN_LIKE_RE.test(text);
  }
  // Remaining structured labels need at least 4 digits
  return NUMERIC_ID_RE.test(text);
};

/**
 * Common words that NER incorrectly labels as person
 * names. Only applied to NER-sourced person entities.
 */
const GENERIC_NER_FALSE_POSITIVES = new Set([
  "data",
  "money",
  "payment",
  "contractor",
  "seller",
  "directors",
  "counsellor",
  "count",
  "purchase",
  "share",
  "polish",
  "price",
  "board",
  "group",
  "civil",
  "code",
  "key",
  "company",
  "leaver",
  "pool",
  "change",
  "business",
  "day",
  "meeting",
  "person",
  "service",
  "public",
  "stock",
  "simple",
  "safe",
  "cap",
  "standard",
  "common",
  "slovak",
  "czech",
  "freedom",
  "rector",
  "commission",
  "court",
  "government",
  "state",
  "republic",
  "parliament",
  "council",
  "assembly",
  "ministry",
  "police",
  "chamber",
  "tribunal",
  "applicant",
  "respondent",
  "plaintiff",
  "defendant",
  "claimant",
  "judge",
  "advocate",
  "prosecutor",
  "registrar",
  "registry",
  "section",
  "division",
  "article",
]);

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
 * standalone years, generic legal role terms, legal
 * references, too-short NER spans, structured label
 * mismatches, and generic NER person false positives.
 *
 * Runs as a post-processing step after all detection
 * layers have merged.
 */
export const filterFalsePositives = (entities: Entity[]): Entity[] => {
  const filtered: Entity[] = [];

  for (const entity of entities) {
    const trimmed = entity.text.trim();
    const isNer = entity.source === DETECTION_SOURCES.NER;

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

    // NER-specific filters
    if (isNer) {
      // Too-short NER entities (< 3 chars)
      if (trimmed.length < MIN_NER_TEXT_LENGTH) {
        continue;
      }

      // Legal references misidentified by NER
      if (LEGAL_REFERENCE_RE.test(trimmed)) {
        continue;
      }

      // Structured labels must look like their format
      if (
        STRUCTURED_LABELS.has(entity.label) &&
        !looksLikeStructuredLabel(entity.label, trimmed)
      ) {
        continue;
      }

      // Common words misidentified as person names
      if (
        entity.label === "person" &&
        GENERIC_NER_FALSE_POSITIVES.has(trimmed.toLowerCase())
      ) {
        continue;
      }
    }

    filtered.push(entity);
  }

  return filtered;
};
