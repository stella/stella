import { panic } from "better-result";

import {
  E_SBIRKA_LIST_SCHEME,
  flatStatuteLists,
  SLOV_LEX_LIST_SCHEME,
} from "@stll/legal-ast/statute-list";
import type { StatuteListScheme } from "@stll/legal-ast/statute-list";

import { isPublicCountry } from "./public-country-capability";
import type { PublicCountry } from "./public-country-capability";

/** A country whose statute text is not public yet, so no stored provision verifies a grammar. */
const UNVERIFIED_ANCHORS = flatStatuteLists(
  "Legislation is not public yet; no stored provision verifies an anchor grammar.",
);

/**
 * How each public country's statute anchors state list nesting. The key set
 * is the public country list, so a country cannot reach the statute reader
 * without declaring its publisher's anchor grammar or saying why it has none.
 */
export const STATUTE_LIST_SCHEMES = {
  AUT: UNVERIFIED_ANCHORS,
  BRA: UNVERIFIED_ANCHORS,
  CZE: E_SBIRKA_LIST_SCHEME,
  EU: flatStatuteLists("EU acts open at EUR-Lex, not in the statute reader."),
  GBR: UNVERIFIED_ANCHORS,
  HUN: UNVERIFIED_ANCHORS,
  POL: UNVERIFIED_ANCHORS,
  SVK: SLOV_LEX_LIST_SCHEME,
  USA: flatStatuteLists(
    "US Code anchors (`s1983/a/1`) are positional and no stored consolidation sets their depths.",
  ),
} as const satisfies Record<PublicCountry, StatuteListScheme>;

/**
 * The list scheme of the publisher a statute's country names. Codes are
 * canonically upper-case; a stored `svk` names the same country. A country
 * outside the public list holds no statutes, so reaching one is a bug.
 */
export const statuteListSchemeFor = (country: string): StatuteListScheme => {
  const canonical = country.trim().toUpperCase();
  return isPublicCountry(canonical)
    ? STATUTE_LIST_SCHEMES[canonical]
    : panic(`No statute list scheme for country "${country}".`);
};
