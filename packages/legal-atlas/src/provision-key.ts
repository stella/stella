import { Result } from "better-result";
import * as v from "valibot";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type {
  ProvisionKey,
  ProvisionRef,
} from "@stll/api-contract/provision-key";
import { provisionReferenceSchema } from "@stll/legal-ast/provision-reference";
import type { ProvisionReference } from "@stll/legal-ast/provision-reference";
import { normalizeUnicode } from "@stll/text-normalize";

import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";

const supportedGrammars = Object.values(PROVISION_CITATION_GRAMMARS).filter(
  (grammar) => grammar.status === "supported",
);
const supportedJurisdictions = supportedGrammars.map(
  (grammar) => grammar.jurisdiction,
);
export type SupportedProvisionJurisdiction =
  (typeof supportedJurisdictions)[number];
const keyPartSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check(
    (value) =>
      value.isWellFormed() &&
      !/[\p{Cc}\p{Cf}]/u.test(value) &&
      value === normalizeUnicode(value, "NFC"),
    "Expected canonical provision identity",
  ),
);
const entries = {
  jurisdiction: v.picklist(supportedJurisdictions),
  workIdentifier: keyPartSchema,
  anchor: keyPartSchema,
};
// Private brand pipes: exported operations validate semantic identity before minting.
const keySchema = v.pipe(
  v.object(entries),
  v.brand("ProvisionKey"),
  v.readonly(),
) satisfies v.GenericSchema<
  unknown,
  ProvisionKey<SupportedProvisionJurisdiction>
>;
const refSchema = v.pipe(
  v.object({
    ...entries,
    workEli: v.nullable(keyPartSchema),
    reference: v.pipe(provisionReferenceSchema, v.readonly()),
  }),
  v.brand("ProvisionKey"),
  v.brand("ProvisionRef"),
  v.readonly(),
) satisfies v.GenericSchema<
  unknown,
  ProvisionRef<SupportedProvisionJurisdiction>
>;
const keyTuple = v.strictTuple([
  v.picklist(supportedJurisdictions),
  v.string(),
  v.string(),
]);

/** Decode the canonical frame and revalidate its identifier with the owning grammar. */
export const parseProvisionKey = (raw: string) => {
  const value = Result.try(() => {
    const decoded: unknown = JSON.parse(raw);
    return decoded;
  }).unwrapOr(null);
  if (JSON.stringify(value) !== raw) {
    return null;
  }
  const tuple = v.safeParse(keyTuple, value);
  if (!tuple.success) {
    return null;
  }
  const [jurisdiction, workIdentifier, anchor] = tuple.output;
  const key = v.safeParse(keySchema, {
    jurisdiction,
    workIdentifier,
    anchor,
  });
  if (!key.success) {
    return null;
  }
  const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
  const work = grammar.gazette.parse(key.output.workIdentifier);
  if (work?.identifier !== key.output.workIdentifier) {
    return null;
  }
  const reference = grammar.parseAnchor(key.output.anchor);
  if (
    reference === null ||
    !v.safeParse(provisionReferenceSchema, reference).success ||
    grammar.anchor(reference) !== key.output.anchor
  ) {
    return null;
  }
  return key.output;
};

type ProvisionRefOfOptions = {
  jurisdiction: CaseLawJurisdiction;
  workIdentifier: string;
  reference: ProvisionReference;
};

type ProvisionRefOfResult =
  | {
      status: "resolved";
      provision: ProvisionRef<SupportedProvisionJurisdiction>;
    }
  | { status: "unsupported" }
  | { status: "invalid_work_identifier" }
  | { status: "invalid_reference" };

/** The minting boundary: normalize work and reference, then derive and brand their identity. */
export const provisionRefOf = ({
  jurisdiction,
  workIdentifier,
  reference,
}: ProvisionRefOfOptions): ProvisionRefOfResult => {
  const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
  if (grammar.status === "unsupported") {
    return { status: "unsupported" };
  }
  const work = grammar.gazette.parse(workIdentifier);
  if (work === null) {
    return { status: "invalid_work_identifier" };
  }
  const normalized = grammar.normalizeReference(reference);
  if (normalized === null) {
    return { status: "invalid_reference" };
  }
  const validated = v.safeParse(provisionReferenceSchema, normalized);
  if (!validated.success) {
    return { status: "invalid_reference" };
  }
  const provision = v.safeParse(refSchema, {
    jurisdiction: grammar.jurisdiction,
    workIdentifier: work.identifier,
    workEli: work.eli,
    reference: validated.output,
    anchor: grammar.anchor(validated.output),
  });
  if (!provision.success) {
    return { status: "invalid_reference" };
  }
  return { status: "resolved", provision: provision.output };
};
