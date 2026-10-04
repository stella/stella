import type { Brand } from "valibot";

import type { ProvisionReference } from "@stll/legal-ast/provision-reference";

import type { CaseLawJurisdiction } from "./case-law-jurisdictions";

/** Stable across consolidation versions and later discovery of a work's ELI. Mint and parse only in legal-atlas. */
export type ProvisionKey<
  TJurisdiction extends CaseLawJurisdiction = CaseLawJurisdiction,
> = Readonly<{
  jurisdiction: TJurisdiction;
  workIdentifier: string;
  anchor: string;
}> &
  Brand<"ProvisionKey">;

/** legal-atlas provisionRefOf derives identity and metadata together through the owning grammar. */
export type ProvisionRef<
  TJurisdiction extends CaseLawJurisdiction = CaseLawJurisdiction,
> = ProvisionKey<TJurisdiction> &
  Readonly<{
    workEli: string | null;
    reference: Readonly<ProvisionReference>;
  }> &
  Brand<"ProvisionRef">;

/** JSON tuple framing excludes version and reference metadata. */
export const formatProvisionKey = ({
  jurisdiction,
  workIdentifier,
  anchor,
}: ProvisionKey): string =>
  JSON.stringify([jurisdiction, workIdentifier, anchor]);
