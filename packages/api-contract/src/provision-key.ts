import { panic, Result } from "better-result";
import * as v from "valibot";

import type { ProvisionReference } from "@stll/legal-ast/provision-reference";

import { CASE_LAW_JURISDICTIONS } from "./case-law-jurisdictions";
import type { CaseLawJurisdiction } from "./case-law-jurisdictions";

/** Stable across consolidation versions and later discovery of a work's ELI. */
export type ProvisionKey = {
  jurisdiction: CaseLawJurisdiction;
  workIdentifier: string;
  anchor: string;
};

export type ProvisionRef = ProvisionKey & {
  workEli: string | null;
  reference: ProvisionReference;
};

const keyPartsSchema = v.tuple([
  v.picklist(CASE_LAW_JURISDICTIONS),
  v.pipe(v.string(), v.minLength(1)),
  v.pipe(v.string(), v.minLength(1)),
]);

/** JSON tuple framing preserves delimiters and Unicode without country-specific syntax. */
export const formatProvisionKey = ({
  jurisdiction,
  workIdentifier,
  anchor,
}: ProvisionKey): string => {
  const parsed = v.safeParse(keyPartsSchema, [
    jurisdiction,
    workIdentifier,
    anchor,
  ]);
  if (!parsed.success) {
    return panic("Invalid provision key");
  }
  return JSON.stringify(parsed.output);
};

/** Accept only the canonical spelling; version and reference metadata are not key parts. */
export const parseProvisionKey = (raw: string): ProvisionKey | null => {
  const value: unknown = Result.try(() => JSON.parse(raw)).unwrapOr(null);
  const parsed = v.safeParse(keyPartsSchema, value);
  if (!parsed.success || JSON.stringify(parsed.output) !== raw) {
    return null;
  }
  const [jurisdiction, workIdentifier, anchor] = parsed.output;
  return { jurisdiction, workIdentifier, anchor };
};
