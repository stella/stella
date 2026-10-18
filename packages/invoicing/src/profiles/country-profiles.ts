import { INVOICE_LANGUAGES, type InvoiceLanguage } from "@stll/api-contract";

import type { VatTreatment } from "../types";
import { INVOICE_PDF_LABELS } from "./pdf-labels";

export { INVOICE_LANGUAGES, type InvoiceLanguage };

export const INVOICE_COUNTRIES = ["SK", "CZ", "EU"] as const;
export type InvoiceCountry = (typeof INVOICE_COUNTRIES)[number];
export type InvoicePartyId = "registration" | "taxId" | "vatId";

type LegalNote = {
  mandated: string;
  translations: Record<InvoiceLanguage, string>;
};
export type InvoiceCountryProfile = {
  /**
   * The currency the law requires the VAT amount to be stated in, or null
   * when the profile prescribes none. Until invoices carry an exchange rate,
   * a VAT invoice in any other currency cannot be finalized.
   */
  vatCurrency: "EUR" | "CZK" | null;
  supplyDateLabel: Record<InvoiceLanguage, string>;
  partyIds: {
    seller: readonly InvoicePartyId[];
    buyer: readonly InvoicePartyId[];
  };
  legalNotes: Record<VatTreatment, LegalNote | null>;
};

const translations = (
  values: Partial<Record<InvoiceLanguage, string>>,
  fallback: string,
) =>
  ({
    en: values.en ?? fallback,
    cs: values.cs ?? fallback,
    sk: values.sk ?? fallback,
    de: values.de ?? fallback,
    fr: values.fr ?? fallback,
    es: values.es ?? fallback,
    "pt-BR": values["pt-BR"] ?? fallback,
    pl: values.pl ?? fallback,
    hu: values.hu ?? fallback,
    et: values.et ?? fallback,
    lv: values.lv ?? fallback,
    lt: values.lt ?? fallback,
    ar: values.ar ?? fallback,
  }) satisfies Record<InvoiceLanguage, string>;

const supplyDateLabels = () =>
  ({
    en: INVOICE_PDF_LABELS.en.taxDate,
    cs: INVOICE_PDF_LABELS.cs.taxDate,
    sk: INVOICE_PDF_LABELS.sk.taxDate,
    de: INVOICE_PDF_LABELS.de.taxDate,
    fr: INVOICE_PDF_LABELS.fr.taxDate,
    es: INVOICE_PDF_LABELS.es.taxDate,
    "pt-BR": INVOICE_PDF_LABELS["pt-BR"].taxDate,
    pl: INVOICE_PDF_LABELS.pl.taxDate,
    hu: INVOICE_PDF_LABELS.hu.taxDate,
    et: INVOICE_PDF_LABELS.et.taxDate,
    lv: INVOICE_PDF_LABELS.lv.taxDate,
    lt: INVOICE_PDF_LABELS.lt.taxDate,
    ar: INVOICE_PDF_LABELS.ar.taxDate,
  }) satisfies Record<InvoiceLanguage, string>;

const note = (
  mandated: string,
  translated: Partial<Record<InvoiceLanguage, string>>,
): LegalNote => ({
  mandated,
  translations: translations(translated, translated.en ?? mandated),
});

const noLegalNotes = {
  domestic_vat: null,
  not_vat_payer: null,
  reverse_charge: null,
  outside_scope: null,
  exempt: null,
} satisfies Record<VatTreatment, null>;

const commonPartyIds = {
  seller: ["registration", "vatId"],
  buyer: ["registration", "vatId"],
} as const;

// Slovak parties carry a tax ID (DIČ) separate from the VAT ID (IČ DPH);
// § 74 ods. 1 písm. a) and b) require the IČ DPH, practice prints both.
const slovakPartyIds = {
  seller: ["registration", "taxId", "vatId"],
  buyer: ["registration", "taxId", "vatId"],
} as const;

export const INVOICE_COUNTRY_PROFILES = {
  // Zákon č. 222/2004 Z. z. o dani z pridanej hodnoty, consolidation in force
  // from 2026-01-01 (slov-lex.sk), § 74 ods. 1.
  SK: {
    // § 74 ods. 1 písm. i): "výšku dane spolu v eurách".
    vatCurrency: "EUR",
    supplyDateLabel: supplyDateLabels(),
    partyIds: slovakPartyIds,
    legalNotes: {
      domestic_vat: null,
      // Not prescribed wording; states why no VAT is charged.
      not_vat_payer: note("Dodávateľ nie je platiteľom DPH.", {
        sk: "Dodávateľ nie je platiteľom DPH.",
        en: "The supplier is not a VAT payer.",
        cs: "Dodavatel není plátcem DPH.",
      }),
      // § 74 ods. 1 písm. k): slovná informácia „prenesenie daňovej povinnosti“.
      reverse_charge: note("Prenesenie daňovej povinnosti.", {
        sk: "Prenesenie daňovej povinnosti.",
        en: "Reverse charge.",
        cs: "Přenesení daňové povinnosti.",
      }),
      // Not prescribed wording; place of supply outside Slovakia (§ 15 ods. 1).
      outside_scope: note("Miesto dodania služby je mimo tuzemska.", {
        sk: "Miesto dodania služby je mimo tuzemska.",
        en: "The place of supply of the service is outside the country.",
        cs: "Místo plnění služby je mimo tuzemsko.",
      }),
      // § 74 ods. 1 písm. h): slovná informácia „dodanie je oslobodené od dane“.
      exempt: note("Dodanie je oslobodené od dane.", {
        sk: "Dodanie je oslobodené od dane.",
        en: "The supply is exempt from tax.",
        cs: "Dodání je osvobozeno od daně.",
      }),
    },
  },
  // Zákon č. 235/2004 Sb. o dani z přidané hodnoty, version in force from
  // 2026-01-01 (e-Sbírka), § 29.
  CZ: {
    // § 29 odst. 1 písm. l): "výši daně; tato daň se uvádí v české měně".
    vatCurrency: "CZK",
    supplyDateLabel: supplyDateLabels(),
    partyIds: commonPartyIds,
    legalNotes: {
      domestic_vat: null,
      // Not prescribed wording; states why no VAT is charged.
      not_vat_payer: note("Dodavatel není plátcem DPH.", {
        cs: "Dodavatel není plátcem DPH.",
        en: "The supplier is not a VAT payer.",
        sk: "Dodávateľ nie je platiteľom DPH.",
      }),
      // § 29 odst. 2 písm. c): „daň odvede zákazník“.
      reverse_charge: note("Daň odvede zákazník.", {
        cs: "Daň odvede zákazník.",
        en: "The customer accounts for the tax.",
        sk: "Daň odvedie zákazník.",
      }),
      // Not prescribed wording; place of supply outside Czechia.
      outside_scope: note("Plnění není předmětem daně v tuzemsku.", {
        cs: "Plnění není předmětem daně v tuzemsku.",
        en: "The supply is not subject to domestic tax.",
        sk: "Plnenie nie je predmetom dane v tuzemsku.",
      }),
      // § 29 odst. 2 písm. a): a statement that the supply is exempt.
      exempt: note("Plnění osvobozené od daně.", {
        cs: "Plnění osvobozené od daně.",
        en: "Supply exempt from tax.",
        sk: "Plnenie oslobodené od dane.",
      }),
    },
  },
  EU: {
    vatCurrency: null,
    supplyDateLabel: supplyDateLabels(),
    partyIds: commonPartyIds,
    legalNotes: noLegalNotes,
  },
} as const satisfies Record<InvoiceCountry, InvoiceCountryProfile>;

export const invoiceCountryOf = (seller: {
  country: string | null;
  vatId: string | null;
}): InvoiceCountry => {
  const country = seller.country?.trim().toUpperCase();
  if (country === "SK" || country === "CZ") {
    return country;
  }
  const vatCountry = seller.vatId?.trim().slice(0, 2).toUpperCase();
  return vatCountry === "SK" || vatCountry === "CZ" ? vatCountry : "EU";
};

export const legalNotesFor = ({
  profile,
  language,
  treatments,
  exemptionReasons = [],
}: {
  profile: InvoiceCountryProfile;
  language: InvoiceLanguage;
  treatments: readonly VatTreatment[];
  exemptionReasons?: readonly string[];
}): string[] => {
  const unique = new Set(treatments);
  const notes: string[] = [];
  for (const treatment of unique) {
    const legalNote = profile.legalNotes[treatment];
    if (legalNote === null) {
      continue;
    }
    const translated = legalNote.translations[language];
    const wording =
      translated === legalNote.mandated
        ? legalNote.mandated
        : `${legalNote.mandated} ${translated}`;
    const reasons =
      treatment === "exempt"
        ? exemptionReasons.filter((reason) => reason.trim() !== "")
        : [];
    notes.push(
      reasons.length === 0
        ? wording
        : `${wording} ${[...new Set(reasons)].join("; ")}`,
    );
  }
  return notes;
};
