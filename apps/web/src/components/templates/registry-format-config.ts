import {
  ARES_COURT_GENITIVE_TOKEN,
  ARES_COURT_INSTRUMENTAL_TOKEN,
} from "@stll/business-registries/ares/court-names";
import {
  ARES_FILE_REFERENCE_TOKEN,
  ARES_IDENTIFIER_SPACED_TOKEN,
} from "@stll/business-registries/ares/default-format";
import { BRREG_IDENTIFIER_SPACED_TOKEN } from "@stll/business-registries/brreg/identifier-format";
import { BUSINESS_REGISTRY_FORMAT_CAPABILITIES } from "@stll/business-registries/default-formats";
import { EIN_DASHED_TOKEN } from "@stll/business-registries/edgar/identifier-format";
import { ORSR_COURT_GENITIVE_TOKEN } from "@stll/business-registries/orsr/court-names";
import {
  ORSR_INSERT_TOKEN,
  ORSR_SECTION_TOKEN,
} from "@stll/business-registries/orsr/default-format";
import { ORSR_IDENTIFIER_SPACED_TOKEN } from "@stll/business-registries/orsr/identifier-format";
import {
  SIREN_SPACED_TOKEN,
  SIRET_SPACED_TOKEN,
} from "@stll/business-registries/recherche-entreprises/identifier-format";

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
      ARES_IDENTIFIER_SPACED_TOKEN,
      "share capital",
      "court file",
      ARES_COURT_INSTRUMENTAL_TOKEN,
      ARES_COURT_GENITIVE_TOKEN,
      ARES_FILE_REFERENCE_TOKEN,
      "registered on",
      "acting clause",
      "statutory bodies",
    ],
    orsr: [
      ...REGISTRY_BASE_RETURN_FIELDS,
      ORSR_IDENTIFIER_SPACED_TOKEN,
      "share capital",
      "share capital paid",
      "court file",
      ORSR_SECTION_TOKEN,
      ORSR_INSERT_TOKEN,
      ORSR_COURT_GENITIVE_TOKEN,
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
    brreg: [
      ...REGISTRY_BASE_RETURN_FIELDS,
      BRREG_IDENTIFIER_SPACED_TOKEN,
      "registered on",
    ],
    prh: [...REGISTRY_BASE_RETURN_FIELDS, "registered on"],
    "recherche-entreprises": [
      ...REGISTRY_BASE_RETURN_FIELDS,
      "SIREN",
      SIREN_SPACED_TOKEN,
      "SIRET",
      SIRET_SPACED_TOKEN,
      "head office address",
      "registered on",
    ],
    edgar: [...REGISTRY_BASE_RETURN_FIELDS, "EIN", EIN_DASHED_TOKEN],
    gcis: [
      ...REGISTRY_BASE_RETURN_FIELDS,
      "registering authority",
      "registered on",
    ],
    rpo: [...REGISTRY_BASE_RETURN_FIELDS, "registered on"],
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
  rpo: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.rpo.defaultFormat,
  vies: BUSINESS_REGISTRY_FORMAT_CAPABILITIES.vies.defaultFormat,
} satisfies Record<LookupRegistry, string>;

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
