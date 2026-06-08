/**
 * Maps a business-registry lookup hit onto template fill-form fields.
 *
 * Registry-agnostic: the unified `/contacts/business-registries` endpoint
 * returns one normalized `BusinessRegistryHit` for every adapter, so the
 * mapping keys off that shape (plus per-registry `details` for the richer
 * identifiers). A field-group is autofillable when one of its field paths
 * ends in a recognised suffix (e.g. `tenant.nip`, `landlord.address`).
 */

import type { api } from "@/lib/api";

type LookupResponse = Awaited<
  ReturnType<(typeof api.contacts)["business-registries"]["get"]>
>;

type LookupData = Exclude<
  NonNullable<Extract<LookupResponse, { data: unknown }>["data"]>,
  Response
>;

/** A single normalized lookup hit (canonical-ID lookup, not name search). */
export type RegistryHit = NonNullable<
  Extract<LookupData, { type: "lookup" }>["hit"]
>;

/** Canonical company attributes we can drop into a template field. */
type CanonicalKey =
  | "name"
  | "legalForm"
  | "registrationId"
  | "taxId"
  | "statId"
  | "address"
  | "shareCapital";

/**
 * Last-path-segment (lowercased) → canonical attribute. Covers the common
 * jurisdictions: PL (KRS/NIP/REGON), CZ (IČO/DIČ), GB (company number),
 * EU (VAT). Extend as adapters surface more identifiers.
 */
const SUFFIX_MAP: Record<string, CanonicalKey> = {
  name: "name",
  company_name: "name",
  legal_form: "legalForm",
  legalform: "legalForm",
  form: "legalForm",
  krs: "registrationId",
  ico: "registrationId",
  crn: "registrationId",
  company_number: "registrationId",
  reg_no: "registrationId",
  registration_number: "registrationId",
  nip: "taxId",
  vat: "taxId",
  vat_id: "taxId",
  dic: "taxId",
  tax_id: "taxId",
  regon: "statId",
  stat_id: "statId",
  address: "address",
  seat: "address",
  registered_office: "address",
  share_capital: "shareCapital",
  capital: "shareCapital",
};

/** Share capital is surfaced verbatim by the adapter; pair it with the
 *  ISO currency for display (e.g. `99910510,00 PLN`). */
const formatShareCapital = (capital: {
  amount: string;
  currency: string;
}): string => `${capital.amount} ${capital.currency}`;

/** Project a hit onto the canonical attributes it can fill. */
export const extractRegistryFields = (
  hit: RegistryHit,
): Partial<Record<CanonicalKey, string>> => {
  const out: Partial<Record<CanonicalKey, string>> = {};

  if (hit.name) {
    out.name = hit.name;
  }
  if (hit.legalForm) {
    out.legalForm = hit.legalForm;
  }
  // The canonical id is the registration number for the chosen registry
  // (KRS number, IČO, company number, …).
  if (hit.id) {
    out.registrationId = hit.id;
  }
  if (hit.address?.textAddress) {
    out.address = hit.address.textAddress;
  }

  // Per-registry identifiers live on the discriminated `details`.
  const details = hit.details;
  if (details?.registry === "krs") {
    const { identifiers, shareCapital } = details.entity;
    if (identifiers.nip) {
      out.taxId = identifiers.nip;
    }
    if (identifiers.regon) {
      out.statId = identifiers.regon;
    }
    if (shareCapital) {
      out.shareCapital = formatShareCapital(shareCapital);
    }
  }

  return out;
};

const suffixOf = (path: string): string | undefined =>
  path.split(".").at(-1)?.toLowerCase();

/** True when at least one field in the group can be registry-filled. */
export const groupSupportsRegistryAutofill = (
  groupFields: readonly { path: string }[],
): boolean =>
  groupFields.some((field) => {
    const suffix = suffixOf(field.path);
    return suffix !== undefined && suffix in SUFFIX_MAP;
  });

/** Resolve which field paths to set, and to what, from a hit. */
export const buildAutofillUpdates = (
  groupFields: readonly { path: string }[],
  hit: RegistryHit,
): { path: string; value: string }[] => {
  const canonical = extractRegistryFields(hit);
  const updates: { path: string; value: string }[] = [];

  for (const field of groupFields) {
    const suffix = suffixOf(field.path);
    if (suffix === undefined) {
      continue;
    }
    const key = SUFFIX_MAP[suffix];
    if (key === undefined) {
      continue;
    }
    const value = canonical[key];
    if (value !== undefined) {
      updates.push({ path: field.path, value });
    }
  }

  return updates;
};
