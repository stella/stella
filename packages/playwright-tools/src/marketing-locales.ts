// The marketing stills are captured once per locale, each from its own
// seeded firm: a deterministic organization and owner whose matters,
// documents and fixture AI output the dev seed writes in that language
// (apps/api/scripts/seed-marketing-locales.ts). The seed and the capture
// spec both read this module, so the ids, names and ready markers they meet
// on cannot drift apart.
//
// A locale is a market: a UI language plus the country whose law the content
// is written for. Ids are BCP 47 tags; a second market for a language that
// already has one carries its region (a German pack for Austria next to one
// for Germany would be "de-AT" and "de-DE"). Adding a market is one id here,
// its entries in the records below and its content pack
// (apps/api/scripts/seed-content); each record is total over the ids, so a
// missing entry fails typecheck.

export const MARKETING_LOCALES = ["en", "cs", "sk"] as const;

export type MarketingLocale = (typeof MARKETING_LOCALES)[number];

/**
 * The dev seed's default firm: it keeps the unnamespaced seed ids and the
 * unsuffixed PNG names, and its run seeds the shared case-law corpus every
 * other firm reuses.
 */
export const PRIMARY_MARKETING_LOCALE = "en" satisfies MarketingLocale;

type MarketingLocaleAccount = {
  /** UI catalog the firm renders in (apps/web/src/i18n/langs/<language>.json). */
  language: string;
  /**
   * ISO 3166-1 alpha-2 country whose law the content is written for; the
   * firm's primary practice jurisdiction.
   */
  country: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  userId: string;
  userName: string;
  email: string;
  /** Browser locale of the capture: drives the UI language and formatting. */
  browserLocale: string;
  /** Appended to every PNG name; English keeps the historical names. */
  captureSuffix: string;
};

export const MARKETING_LOCALE_ACCOUNTS = {
  en: {
    language: "en",
    // The English cast practises Czech law, like the case law it films.
    country: "CZ",
    organizationId: "test-org-stella-dev",
    organizationName: "Harbrook & Partners",
    organizationSlug: "harbrook-partners",
    userId: "test-user-stella-dev",
    userName: "Petra Harbrook",
    email: "test@stella.dev",
    browserLocale: "en-GB",
    captureSuffix: "",
  },
  cs: {
    language: "cs",
    country: "CZ",
    organizationId: "test-org-stella-dev-cs",
    organizationName: "Hartvich & Partneři",
    organizationSlug: "hartvich-partneri",
    userId: "test-user-stella-dev-cs",
    userName: "Petra Hartvichová",
    email: "test-cs@stella.dev",
    browserLocale: "cs-CZ",
    captureSuffix: "-cs",
  },
  sk: {
    language: "sk",
    country: "SK",
    organizationId: "test-org-stella-dev-sk",
    organizationName: "Hrabovský & Partneri",
    organizationSlug: "hrabovsky-partneri",
    userId: "test-user-stella-dev-sk",
    userName: "Petra Hrabovská",
    email: "test-sk@stella.dev",
    browserLocale: "sk-SK",
    captureSuffix: "-sk",
  },
} as const satisfies Record<MarketingLocale, MarketingLocaleAccount>;

/** The locale whose seeded firm is this organization, if any. */
export const marketingLocaleForOrganization = (
  organizationId: string,
): MarketingLocale | undefined =>
  MARKETING_LOCALES.find(
    (locale) =>
      MARKETING_LOCALE_ACCOUNTS[locale].organizationId === organizationId,
  );

/**
 * The seed-id namespace of a locale's firm. The English firm is the dev
 * seed's default organization and keeps the unnamespaced ids; every other
 * organization's ids are namespaced by its id (apps/api/scripts/seed-utils.ts).
 */
export const marketingSeedNamespace = (locale: MarketingLocale): string =>
  locale === PRIMARY_MARKETING_LOCALE
    ? ""
    : `org:${MARKETING_LOCALE_ACCOUNTS[locale].organizationId}`;

/** The namespaced string a seed id hashes. */
export const seedIdHashInput = (namespace: string, label: string): string =>
  namespace ? `${namespace}:${label}` : label;

/**
 * A seed id's UUID (version 5 layout) from the 64-character SHA-256 hex of
 * its label.
 */
export const formatSeedUuid = (sha256Hex: string): string => {
  const raw = sha256Hex.slice(0, 32);
  const uuid = `${raw.slice(0, 12)}5${raw.slice(13, 16)}8${raw.slice(17)}`;
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20, 32)}`;
};

type MarketingAgentMarkers = {
  threadTitle: string;
  /** The three user turns, in order. */
  questions: readonly [string, string, string];
  /** Opening words of the recap pinned under the last answer. */
  recapPrefix: string;
  /**
   * The final answer's two inline citation chips. `fileName` is the cited
   * review extract, whose body prints its own name.
   */
  citedSources: readonly [
    { chipLabel: string; fileName: string },
    { chipLabel: string; fileName: string },
  ];
  /** Title of the generated view, which its frame carries. */
  viewTitle: string;
};

type MarketingLocaleMarkers = {
  meridianMatterName: string;
  exportReviewMatterName: string;
  supplierAgreementFileName: string;
  safeAgreementFileName: string;
  redactedExtractFileName: string;
  /** The contact that heads the contacts list (sorted by display name). */
  firstContactName: string;
  sentInvoiceNumber: string;
  agent: MarketingAgentMarkers;
  /**
   * Country of the case-law results listing, or null when the locale's own
   * jurisdiction is not admitted to public search yet.
   */
  caseLawSearchCountry: "CZE" | null;
};

/**
 * Seeded names the capture waits on. The seed content of each locale
 * (apps/api/scripts/seed-content) must produce exactly these; a test there
 * binds them.
 */
export const MARKETING_LOCALE_MARKERS = {
  en: {
    meridianMatterName: "Meridian supply agreement",
    exportReviewMatterName: "Export Review - Project Atlas Data Room",
    supplierAgreementFileName: "Supplier_Agreement.docx",
    safeAgreementFileName: "Internal_SAFE_Agreement.docx",
    redactedExtractFileName: "Redacted_Due_Diligence_Extract.docx",
    firstContactName: "Bratislava Legal Group, s.r.o.",
    sentInvoiceNumber: "INV-2025-0003",
    agent: {
      threadTitle: "Project Atlas · Change-of-control review",
      questions: [
        "Which agreements in the Project Atlas data room carry change-of-control risk?",
        "What does the Helios loan agreement say, and when does it expire?",
        "Turn this into a view I can take to the partner meeting.",
      ],
      recapPrefix:
        "You mapped change-of-control exposure across the Project Atlas data room",
      citedSources: [
        {
          chipLabel: "Delta Logistics · Customer Contract 2019",
          fileName: "Delta_Logistics_Customer_Contract_2019.docx",
        },
        {
          chipLabel: "Helios Energy · Loan Agreement 2023",
          fileName: "Helios_Energy_Loan_Agreement_2023.docx",
        },
      ],
      viewTitle: "Change-of-control exposure · Project Atlas",
    },
    caseLawSearchCountry: "CZE",
  },
  cs: {
    meridianMatterName: "Smlouva o dodávkách – Meridian",
    exportReviewMatterName: "Prověrka datové místnosti – Projekt Atlas",
    supplierAgreementFileName: "Smlouva_o_dodavkach.docx",
    safeAgreementFileName: "Smlouva_o_budoucim_podilu_SAFE.docx",
    redactedExtractFileName: "Anonymizovany_vytah_z_DD.docx",
    firstContactName: "Advokátní kancelář Brázda & Kalina, s.r.o.",
    sentInvoiceNumber: "FV-2025-0003",
    agent: {
      threadTitle: "Projekt Atlas · Prověrka změny kontroly",
      questions: [
        "Které smlouvy v datové místnosti Projektu Atlas nesou riziko změny kontroly?",
        "Co stanoví úvěrová smlouva se společností Helios a kdy končí?",
        "Připrav z toho přehled, se kterým půjdu na poradu partnerů.",
      ],
      recapPrefix:
        "Zmapovali jste dopady změny kontroly napříč datovou místností Projektu Atlas",
      citedSources: [
        {
          chipLabel: "Delta Logistika · Smlouva s odběratelem 2019",
          fileName: "Delta_Logistika_Smlouva_s_odberatelem_2019.docx",
        },
        {
          chipLabel: "Helios Energie · Úvěrová smlouva 2023",
          fileName: "Helios_Energie_Uverova_smlouva_2023.docx",
        },
      ],
      viewTitle: "Dopady změny kontroly · Projekt Atlas",
    },
    caseLawSearchCountry: "CZE",
  },
  sk: {
    meridianMatterName: "Zmluva o dodávkach – Meridian",
    exportReviewMatterName: "Preverenie dátovej miestnosti – Projekt Atlas",
    supplierAgreementFileName: "Zmluva_o_dodavkach.docx",
    safeAgreementFileName: "Zmluva_o_buducom_podiele_SAFE.docx",
    redactedExtractFileName: "Anonymizovany_vytah_z_DD.docx",
    firstContactName: "Advokátska kancelária Bednár & Kollár, s.r.o.",
    sentInvoiceNumber: "FA-2025-0003",
    agent: {
      threadTitle: "Projekt Atlas · Preverenie zmeny kontroly",
      questions: [
        "Ktoré zmluvy v dátovej miestnosti Projektu Atlas nesú riziko zmeny kontroly?",
        "Čo ustanovuje úverová zmluva so spoločnosťou Helios a kedy končí?",
        "Priprav z toho prehľad, s ktorým pôjdem na poradu partnerov.",
      ],
      recapPrefix:
        "Zmapovali ste dosahy zmeny kontroly naprieč dátovou miestnosťou Projektu Atlas",
      citedSources: [
        {
          chipLabel: "Delta Logistika · Zmluva s odberateľom 2019",
          fileName: "Delta_Logistika_Zmluva_s_odberatelom_2019.docx",
        },
        {
          chipLabel: "Helios Energia · Úverová zmluva 2023",
          fileName: "Helios_Energia_Uverova_zmluva_2023.docx",
        },
      ],
      viewTitle: "Dosahy zmeny kontroly · Projekt Atlas",
    },
    // Slovak case law is published as decision pages but not yet admitted to
    // public search, so the Slovak set films its readers and no listing.
    caseLawSearchCountry: null,
  },
} as const satisfies Record<MarketingLocale, MarketingLocaleMarkers>;
