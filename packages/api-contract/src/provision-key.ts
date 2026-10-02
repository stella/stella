import * as v from "valibot";

import { provisionReferenceSchema } from "@stll/legal-ast/provision-reference";

import type { CaseLawJurisdiction } from "./case-law-jurisdictions";

export const provisionKeyPartSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check(
    (value) => value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value),
    "Expected a well-formed provision identity without control characters",
  ),
  v.transform((value) => value.normalize("NFC")),
);

/** The jurisdiction grammar owner supplies its derived supported set. */
export const provisionIdentitySchemas = <
  const TJurisdiction extends CaseLawJurisdiction,
>(
  jurisdictions: readonly TJurisdiction[],
) => {
  const entries = {
    jurisdiction: v.picklist(jurisdictions),
    workIdentifier: provisionKeyPartSchema,
    anchor: provisionKeyPartSchema,
  };
  return {
    key: v.pipe(v.object(entries), v.brand("ProvisionKey"), v.readonly()),
    ref: v.pipe(
      v.object({
        ...entries,
        workEli: v.nullable(provisionKeyPartSchema),
        reference: v.pipe(provisionReferenceSchema, v.readonly()),
      }),
      v.brand("ProvisionKey"),
      v.brand("ProvisionRef"),
      v.readonly(),
    ),
  };
};

/** Stable across consolidation versions and later discovery of a work's ELI. */
export type ProvisionKey<
  TJurisdiction extends CaseLawJurisdiction = CaseLawJurisdiction,
> = v.InferOutput<ReturnType<typeof provisionIdentitySchemas>["key"]> & {
  readonly jurisdiction: TJurisdiction;
};

/** Mint only through legal-atlas provisionRefOf, which derives identity from its grammar. */
export type ProvisionRef<
  TJurisdiction extends CaseLawJurisdiction = CaseLawJurisdiction,
> = v.InferOutput<ReturnType<typeof provisionIdentitySchemas>["ref"]> & {
  readonly jurisdiction: TJurisdiction;
};

/** JSON tuple framing preserves delimiters; version and reference metadata are excluded. */
export const formatProvisionKey = ({
  jurisdiction,
  workIdentifier,
  anchor,
}: ProvisionKey): string =>
  JSON.stringify([jurisdiction, workIdentifier, anchor]);
