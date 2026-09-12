import { ARES_COURT_INSTRUMENTAL_TOKEN } from "@stll/business-registries/ares/court-names";
import {
  ARES_DEFAULT_FORMAT,
  ARES_FILE_REFERENCE_TOKEN,
} from "@stll/business-registries/ares/default-format";

import type { LookupRegistry } from "@/components/templates/template-field-manifest";

/** Cross-registry fields accepted by the lookup template renderer. */
const REGISTRY_BASE_RETURN_FIELDS = [
  "company name",
  "legal form",
  "seat",
  "address",
  "registry number",
  "postal code",
  "country",
] as const;

/** Token names offered by the format editor, kept total over every registry. */
export const REGISTRY_RETURN_FIELDS: Record<LookupRegistry, readonly string[]> =
  {
    ares: [
      ...REGISTRY_BASE_RETURN_FIELDS,
      "share capital",
      "court file",
      ARES_COURT_INSTRUMENTAL_TOKEN,
      ARES_FILE_REFERENCE_TOKEN,
      "registered on",
      "acting clause",
      "statutory bodies",
    ],
    orsr: [
      ...REGISTRY_BASE_RETURN_FIELDS,
      "share capital",
      "share capital paid",
      "court file",
      "registered on",
      "acting clause",
    ],
    krs: [
      ...REGISTRY_BASE_RETURN_FIELDS,
      "NIP",
      "REGON",
      "share capital",
      "registered on",
    ],
    "companies-house": [
      ...REGISTRY_BASE_RETURN_FIELDS,
      "registered on",
      "jurisdiction",
    ],
    denue: REGISTRY_BASE_RETURN_FIELDS.filter(
      (fieldName) => fieldName !== "legal form",
    ),
    brreg: [...REGISTRY_BASE_RETURN_FIELDS, "registered on"],
    prh: [...REGISTRY_BASE_RETURN_FIELDS, "registered on"],
    "recherche-entreprises": [...REGISTRY_BASE_RETURN_FIELDS, "registered on"],
    edgar: [...REGISTRY_BASE_RETURN_FIELDS, "EIN"],
    gcis: [...REGISTRY_BASE_RETURN_FIELDS, "registered on"],
    vies: [...REGISTRY_BASE_RETURN_FIELDS, "VAT number"],
  };

const GENERIC_DEFAULT_FORMAT = "[company name], [registry number], [address]";

/** Default legal-description format seeded for each registry. */
export const REGISTRY_DEFAULT_FORMAT: Record<LookupRegistry, string> = {
  krs: "[company name] with its registered office at [address], entered in the Register of Entrepreneurs under KRS no. [registry number], kept by Krajowy Rejestr Sądowy, share capital of [share capital], Tax Identification Number (NIP) [NIP], Statistical Identification Number (REGON) [REGON]",
  ares: ARES_DEFAULT_FORMAT,
  orsr: GENERIC_DEFAULT_FORMAT,
  "companies-house": GENERIC_DEFAULT_FORMAT,
  denue: GENERIC_DEFAULT_FORMAT,
  brreg: GENERIC_DEFAULT_FORMAT,
  prh: GENERIC_DEFAULT_FORMAT,
  "recherche-entreprises": GENERIC_DEFAULT_FORMAT,
  edgar: GENERIC_DEFAULT_FORMAT,
  gcis: GENERIC_DEFAULT_FORMAT,
  vies: GENERIC_DEFAULT_FORMAT,
};

/** Curated token examples shown in Template Studio tooltips. */
export const REGISTRY_FIELD_EXAMPLES: Partial<
  Record<LookupRegistry, Record<string, string>>
> = {
  krs: {
    "company name": "CD PROJEKT S.A.",
    "legal form": "spółka akcyjna",
    seat: "Warszawa",
    address: "ul. Jagiellońska 74, 03-301 Warszawa",
    "registry number": "0000006865",
    NIP: "7342867148",
    REGON: "492707333",
    "share capital": "100 000 000,00 PLN",
  },
};
