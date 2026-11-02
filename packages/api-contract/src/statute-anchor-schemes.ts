import { panic } from "better-result";

import {
  E_SBIRKA_ANCHORS,
  SLOV_LEX_ANCHORS,
  US_CODE_ANCHORS,
  wholeStatuteAnchors,
} from "@stll/legal-ast/statute-anchor-scheme";
import type { StatuteAnchorScheme } from "@stll/legal-ast/statute-anchor-scheme";

import { isPublicCountry } from "./public-country-capability";
import type { PublicCountry } from "./public-country-capability";

/** A country whose statute text is not public yet, so no stored provision verifies a grammar. */
const UNVERIFIED_ANCHORS = wholeStatuteAnchors(
  "Legislation is not public yet; no stored provision verifies an anchor grammar.",
);

/**
 * The anchor grammar of each public country's statute publisher. The key
 * set is the public country list, so a country cannot reach the statute
 * reader, a provision preview or a provision read without declaring its
 * publisher's grammar or saying why its anchors are read whole.
 */
export const STATUTE_ANCHOR_SCHEMES = {
  AUT: UNVERIFIED_ANCHORS,
  CZE: E_SBIRKA_ANCHORS,
  EU: wholeStatuteAnchors(
    "EU acts open at EUR-Lex, not in the statute reader.",
  ),
  GBR: UNVERIFIED_ANCHORS,
  HUN: UNVERIFIED_ANCHORS,
  POL: UNVERIFIED_ANCHORS,
  SVK: SLOV_LEX_ANCHORS,
  USA: US_CODE_ANCHORS,
} as const satisfies Record<PublicCountry, StatuteAnchorScheme>;

/**
 * The anchor scheme of the publisher a statute's country names. Codes are
 * canonically upper-case; a stored `svk` names the same country. A country
 * outside the public list holds no statutes, so reaching one is a bug.
 */
export const statuteAnchorSchemeFor = (
  country: string,
): StatuteAnchorScheme => {
  const canonical = country.trim().toUpperCase();
  return isPublicCountry(canonical)
    ? STATUTE_ANCHOR_SCHEMES[canonical]
    : panic(`No statute anchor scheme for country "${country}".`);
};
