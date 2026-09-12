import { ARES_COURT_INSTRUMENTAL_TOKEN } from "@stll/business-registries/ares/court-names";
import { ARES_FILE_REFERENCE_TOKEN } from "@stll/business-registries/ares/default-format";
import { BUSINESS_REGISTRY_FORMAT_CAPABILITIES } from "@stll/business-registries/default-formats";

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
    "recherche-entreprises": [
      ...REGISTRY_BASE_RETURN_FIELDS,
      "SIREN",
      "SIRET",
      "head office address",
      "registered on",
    ],
    edgar: [...REGISTRY_BASE_RETURN_FIELDS, "EIN"],
    gcis: [
      ...REGISTRY_BASE_RETURN_FIELDS,
      "registering authority",
      "registered on",
    ],
    vies: [...REGISTRY_BASE_RETURN_FIELDS, "VAT number"],
  };

/** Built-in registry outputs shared with the desktop rendering path. */
export const REGISTRY_DEFAULT_FORMAT = {
  ares: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.ares.defaultFormat,
  brreg: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.brreg.defaultFormat,
  "companies-house":
    BUSINESS_REGISTRY_FORMAT_CAPABILITIES["companies-house"].defaultFormat,
  denue: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.denue.defaultFormat,
  edgar: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.edgar.defaultFormat,
  gcis: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.gcis.defaultFormat,
  krs: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.krs.defaultFormat,
  orsr: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.orsr.defaultFormat,
  prh: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.prh.defaultFormat,
  "recherche-entreprises":
    BUSINESS_REGISTRY_FORMAT_CAPABILITIES["recherche-entreprises"]
      .defaultFormat,
  vies: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.vies.defaultFormat,
} satisfies Record<LookupRegistry, string>;

const PREVIOUS_KRS_DEFAULT_FORMAT =
  "[company name] with its registered office at [address], entered in the Register of Entrepreneurs under KRS no. [registry number], kept by Krajowy Rejestr Sądowy, share capital of [share capital], Tax Identification Number (NIP) [NIP], Statistical Identification Number (REGON) [REGON]";

/**
 * Formats that still represent an untouched built-in row when switching a
 * registry. The KRS entry covers persisted manifests from before the
 * registry-specific defaults; remove it after a migration rewrites those rows.
 */
const REGISTRY_RESEEDABLE_FORMATS = {
  ares: [REGISTRY_DEFAULT_FORMAT.ares],
  brreg: [REGISTRY_DEFAULT_FORMAT.brreg],
  "companies-house": [REGISTRY_DEFAULT_FORMAT["companies-house"]],
  denue: [REGISTRY_DEFAULT_FORMAT.denue],
  edgar: [REGISTRY_DEFAULT_FORMAT.edgar],
  gcis: [REGISTRY_DEFAULT_FORMAT.gcis],
  krs: [REGISTRY_DEFAULT_FORMAT.krs, PREVIOUS_KRS_DEFAULT_FORMAT],
  orsr: [REGISTRY_DEFAULT_FORMAT.orsr],
  prh: [REGISTRY_DEFAULT_FORMAT.prh],
  "recherche-entreprises": [REGISTRY_DEFAULT_FORMAT["recherche-entreprises"]],
  vies: [REGISTRY_DEFAULT_FORMAT.vies],
} as const satisfies Record<LookupRegistry, readonly string[]>;

export const isRegistryReseedableFormat = (
  registry: LookupRegistry,
  format: string,
): boolean =>
  REGISTRY_RESEEDABLE_FORMATS[registry].some(
    (candidate) => candidate === format,
  );

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
