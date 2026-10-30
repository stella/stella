import { normalizeCountry } from "@stll/agent-input/country";
import { INVOICE_LANGUAGES, type InvoiceLanguage } from "@stll/api-contract";

import type { VatTreatment } from "../types";
import { INVOICE_PDF_LABELS } from "./pdf-labels";

export { INVOICE_LANGUAGES, type InvoiceLanguage };

export const INVOICE_COUNTRIES = ["SK", "CZ", "PL", "EU"] as const;
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
  vatCurrency: "EUR" | "CZK" | "PLN" | null;
  domesticTaxIdLabel: string | null;
  supplyDateLabel: Record<InvoiceLanguage, string>;
  partyIds: {
    seller: readonly InvoicePartyId[];
    buyer: readonly InvoicePartyId[];
  };
  legalNotes: Record<VatTreatment, LegalNote | null>;
  exemptionReasonTreatments: readonly VatTreatment[];
};

const NOTE_TRANSLATIONS = {
  not_vat_payer: {
    ar: "المورّد غير مسجل في ضريبة القيمة المضافة.",
    cs: "Dodavatel není plátcem DPH.",
    de: "Der Lieferant ist nicht umsatzsteuerpflichtig.",
    en: "The supplier is not a VAT payer.",
    es: "El proveedor no está sujeto al IVA.",
    et: "Tarnija ei ole käibemaksukohustuslane.",
    fr: "Le fournisseur n’est pas assujetti à la TVA.",
    hu: "A szállító nem áfafizető.",
    lt: "Tiekėjas nėra PVM mokėtojas.",
    lv: "Piegādātājs nav PVN maksātājs.",
    pl: "Dostawca nie jest podatnikiem VAT.",
    "pt-BR": "O fornecedor não é contribuinte do IVA.",
    sk: "Dodávateľ nie je platiteľom DPH.",
  },
  reverse_charge: {
    ar: "الاحتساب العكسي للضريبة.",
    cs: "Přenesení daňové povinnosti.",
    de: "Steuerschuldnerschaft des Leistungsempfängers.",
    en: "Reverse charge.",
    es: "Inversión del sujeto pasivo.",
    et: "Pöördmaksustamine.",
    fr: "Autoliquidation.",
    hu: "Fordított adózás.",
    lt: "Atvirkštinis apmokestinimas.",
    lv: "Nodokļa apgrieztā maksāšana.",
    pl: "Odwrotne obciążenie.",
    "pt-BR": "Autoliquidação.",
    sk: "Prenesenie daňovej povinnosti.",
  },
  outside_scope: {
    ar: "يقع مكان تقديم الخدمة خارج الدولة.",
    cs: "Místo plnění služby je mimo tuzemsko.",
    de: "Der Leistungsort liegt außerhalb des Landes.",
    en: "The place of supply of the service is outside the country.",
    es: "El lugar de prestación del servicio está fuera del país.",
    et: "Teenuse osutamise koht asub väljaspool riiki.",
    fr: "Le lieu de prestation du service se situe hors du pays.",
    hu: "A szolgáltatás teljesítési helye az országon kívül van.",
    lt: "Paslaugos teikimo vieta yra už šalies ribų.",
    lv: "Pakalpojuma sniegšanas vieta atrodas ārpus valsts.",
    pl: "Miejsce świadczenia usługi znajduje się poza krajem.",
    "pt-BR": "O local da prestação do serviço fica fora do país.",
    sk: "Miesto dodania služby je mimo tuzemska.",
  },
  exempt: {
    ar: "التوريد معفى من الضريبة.",
    cs: "Plnění osvobozené od daně.",
    de: "Die Leistung ist steuerbefreit.",
    en: "The supply is exempt from tax.",
    es: "La prestación está exenta de impuestos.",
    et: "Teenus on maksuvaba.",
    fr: "La prestation est exonérée de taxe.",
    hu: "A szolgáltatás adómentes.",
    lt: "Paslauga neapmokestinama.",
    lv: "Pakalpojums ir atbrīvots no nodokļa.",
    pl: "Świadczenie jest zwolnione z podatku.",
    "pt-BR": "A prestação é isenta de imposto.",
    sk: "Dodanie je oslobodené od dane.",
  },
} satisfies Record<
  Exclude<VatTreatment, "domestic_vat">,
  Record<InvoiceLanguage, string>
>;

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
  translated: Record<InvoiceLanguage, string>,
): LegalNote => ({
  mandated,
  translations: translated,
});

const noLegalNotes = {
  domestic_vat: null,
  not_vat_payer: null,
  reverse_charge: null,
  outside_scope: null,
  exempt: null,
} satisfies Record<VatTreatment, null>;

// Each identifier prints when the party has it. Slovak parties carry a tax ID
// (DIČ) separate from the VAT ID (IČ DPH); zákon 222/2004 Z. z. § 74 ods. 1
// písm. a) and b) require the IČ DPH, practice prints both.
const commonPartyIds = {
  seller: ["registration", "taxId", "vatId"],
  buyer: ["registration", "taxId", "vatId"],
} as const;

export const INVOICE_COUNTRY_PROFILES = {
  // Zákon č. 222/2004 Z. z. o dani z pridanej hodnoty, consolidation in force
  // from 2026-01-01 (slov-lex.sk), § 74 ods. 1.
  SK: {
    // § 74 ods. 1 písm. i): "výšku dane spolu v eurách".
    vatCurrency: "EUR",
    domesticTaxIdLabel: null,
    supplyDateLabel: supplyDateLabels(),
    partyIds: commonPartyIds,
    legalNotes: {
      domestic_vat: null,
      // Not prescribed wording; states why no VAT is charged.
      not_vat_payer: note("Dodávateľ nie je platiteľom DPH.", {
        ...NOTE_TRANSLATIONS.not_vat_payer,
        sk: "Dodávateľ nie je platiteľom DPH.",
        en: "The supplier is not a VAT payer.",
        cs: "Dodavatel není plátcem DPH.",
      }),
      // § 74 ods. 1 písm. k): slovná informácia „prenesenie daňovej povinnosti“.
      reverse_charge: note("Prenesenie daňovej povinnosti.", {
        ...NOTE_TRANSLATIONS.reverse_charge,
        sk: "Prenesenie daňovej povinnosti.",
        en: "Reverse charge.",
        cs: "Přenesení daňové povinnosti.",
      }),
      // Not prescribed wording; place of supply outside Slovakia (§ 15 ods. 1).
      outside_scope: note("Miesto dodania služby je mimo tuzemska.", {
        ...NOTE_TRANSLATIONS.outside_scope,
        sk: "Miesto dodania služby je mimo tuzemska.",
        en: "The place of supply of the service is outside the country.",
        cs: "Místo plnění služby je mimo tuzemsko.",
      }),
      // § 74 ods. 1 písm. h): slovná informácia „dodanie je oslobodené od dane“.
      exempt: note("Dodanie je oslobodené od dane.", {
        ...NOTE_TRANSLATIONS.exempt,
        sk: "Dodanie je oslobodené od dane.",
        en: "The supply is exempt from tax.",
        cs: "Dodání je osvobozeno od daně.",
      }),
    },
    exemptionReasonTreatments: ["exempt"],
  },
  // Zákon č. 235/2004 Sb. o dani z přidané hodnoty, version in force from
  // 2026-01-01 (e-Sbírka), § 29.
  CZ: {
    // § 29 odst. 1 písm. l): "výši daně; tato daň se uvádí v české měně".
    vatCurrency: "CZK",
    domesticTaxIdLabel: null,
    supplyDateLabel: supplyDateLabels(),
    partyIds: commonPartyIds,
    legalNotes: {
      domestic_vat: null,
      // Not prescribed wording; states why no VAT is charged.
      not_vat_payer: note("Dodavatel není plátcem DPH.", {
        ...NOTE_TRANSLATIONS.not_vat_payer,
        cs: "Dodavatel není plátcem DPH.",
        en: "The supplier is not a VAT payer.",
        sk: "Dodávateľ nie je platiteľom DPH.",
      }),
      // § 29 odst. 2 písm. c): „daň odvede zákazník“.
      reverse_charge: note("Daň odvede zákazník.", {
        ...NOTE_TRANSLATIONS.reverse_charge,
        cs: "Daň odvede zákazník.",
        en: "The customer accounts for the tax.",
        sk: "Daň odvedie zákazník.",
      }),
      // Not prescribed wording; place of supply outside Czechia.
      outside_scope: note("Plnění není předmětem daně v tuzemsku.", {
        ...NOTE_TRANSLATIONS.outside_scope,
        cs: "Plnění není předmětem daně v tuzemsku.",
        en: "The supply is not subject to domestic tax.",
        sk: "Plnenie nie je predmetom dane v tuzemsku.",
      }),
      // § 29 odst. 2 písm. a): a statement that the supply is exempt.
      exempt: note("Plnění osvobozené od daně.", {
        ...NOTE_TRANSLATIONS.exempt,
        cs: "Plnění osvobozené od daně.",
        en: "Supply exempt from tax.",
        sk: "Plnenie oslobodené od dane.",
      }),
    },
    exemptionReasonTreatments: ["exempt"],
  },
  // Ustawa z dnia 11 marca 2004 r. o podatku od towarów i usług,
  // consolidated text, art. 106e.
  PL: {
    // Art. 106e ust. 11: kwoty podatku wykazuje się w złotych.
    vatCurrency: "PLN",
    domesticTaxIdLabel: "NIP",
    supplyDateLabel: supplyDateLabels(),
    // Art. 106e ust. 1 pkt 4 and 5 require the seller's and buyer's NIP.
    partyIds: {
      seller: ["taxId", "vatId"],
      buyer: ["taxId", "vatId"],
    },
    legalNotes: {
      domestic_vat: null,
      // Art. 113 ust. 13 pkt 2 lit. a excludes legal services; the basis is required.
      not_vat_payer: note("Zwolnienie z podatku:", {
        ...NOTE_TRANSLATIONS.exempt,
        pl: "Zwolnienie z podatku:",
        en: "Tax exemption:",
      }),
      // Art. 106e ust. 1 pkt 18 mandates the wording „odwrotne obciążenie”.
      reverse_charge: note("odwrotne obciążenie", {
        ...NOTE_TRANSLATIONS.reverse_charge,
        pl: "odwrotne obciążenie",
      }),
      // Not prescribed wording; the place of supply is outside Poland.
      outside_scope: note(
        "Usługa niepodlegająca opodatkowaniu na terytorium kraju.",
        {
          ...NOTE_TRANSLATIONS.outside_scope,
          pl: "Usługa niepodlegająca opodatkowaniu na terytorium kraju.",
        },
      ),
      // Art. 106e ust. 1 pkt 19 requires the exemption statement and legal basis.
      exempt: note("Zwolnienie z podatku:", {
        ...NOTE_TRANSLATIONS.exempt,
        pl: "Zwolnienie z podatku:",
        en: "Tax exemption:",
      }),
      // Art. 106e ust. 1 pkt 18a does not apply: legal services are not in Annex 15.
    },
    exemptionReasonTreatments: ["exempt", "not_vat_payer"],
  },
  EU: {
    vatCurrency: null,
    domesticTaxIdLabel: null,
    supplyDateLabel: supplyDateLabels(),
    partyIds: commonPartyIds,
    legalNotes: noLegalNotes,
    exemptionReasonTreatments: ["exempt"],
  },
} as const satisfies Record<InvoiceCountry, InvoiceCountryProfile>;

type InvoiceSellerCountryInput = {
  country: string | null;
  vatId: string | null;
};

/** VAT uses EL for Greece and XI for Northern Ireland, unlike ISO address codes. */
const ADDRESS_COUNTRY_OF_VAT_PREFIX: Readonly<Record<string, string>> = {
  EL: "GR",
  XI: "GB",
};

export const invoiceCountryForVatPrefix = (prefix: string) => {
  const country = prefix.toUpperCase();
  const read = normalizeCountry(
    ADDRESS_COUNTRY_OF_VAT_PREFIX[country] ?? country,
    { spelling: "alpha-2" },
  );
  return read.ok ? read.value.alpha2 : null;
};

/** The seller's recognized address wins over a secondary VAT registration. */
export const invoiceSellerCountryOf = (seller: InvoiceSellerCountryInput) => {
  const address = normalizeCountry(seller.country ?? "", {
    spelling: "alpha-2",
  });
  if (address.ok) {
    return address.value.alpha2;
  }
  return invoiceCountryForVatPrefix(seller.vatId?.trim().slice(0, 2) ?? "");
};

export const invoiceCountryOf = (
  seller: InvoiceSellerCountryInput,
): InvoiceCountry => {
  const country = invoiceSellerCountryOf(seller);
  return country === "SK" || country === "CZ" || country === "PL"
    ? country
    : "EU";
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
    const reasons = profile.exemptionReasonTreatments.includes(treatment)
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
