// The eight Slovak registry courts, as enumerated by the register's own court
// selector: https://www.orsr.sk/search_subjekt.asp?lan=sk
//
// The 1 June 2023 court map (zákon č. 150/2022 Z. z.) renamed both city courts
// — Okresný súd Bratislava I → Mestský súd Bratislava III and Okresný súd
// Košice I → Mestský súd Košice — without touching the insert codes:
// https://www.justice.gov.sk/sluzby/obchodny-register/legislativne-zmeny-v-obchodnom-registri/zmeny-k-1-6-2023/
//
// `code` is the letter the register appends to the insert number ("Sro
// 3586/B"). It follows the region, not the court's name — Trenčín is R, Žilina
// L, Banská Bystrica S, Košice V — so it is tabulated, never derived.
//
// `genitive` is the register's own extract wording ("Výpis z Obchodného
// registra Mestského súdu Bratislava III"): only "Mestský/Okresný súd"
// inflects, the city stays in the nominative ("Okresného súdu Trnava", never
// "Trnavy").
const COURT_NAMES: Readonly<
  Record<string, Readonly<{ nominative: string; genitive: string }>>
> = {
  B: {
    nominative: "Mestský súd Bratislava III",
    genitive: "Mestského súdu Bratislava III",
  },
  T: {
    nominative: "Okresný súd Trnava",
    genitive: "Okresného súdu Trnava",
  },
  R: {
    nominative: "Okresný súd Trenčín",
    genitive: "Okresného súdu Trenčín",
  },
  N: {
    nominative: "Okresný súd Nitra",
    genitive: "Okresného súdu Nitra",
  },
  L: {
    nominative: "Okresný súd Žilina",
    genitive: "Okresného súdu Žilina",
  },
  S: {
    nominative: "Okresný súd Banská Bystrica",
    genitive: "Okresného súdu Banská Bystrica",
  },
  P: {
    nominative: "Okresný súd Prešov",
    genitive: "Okresného súdu Prešov",
  },
  V: {
    nominative: "Mestský súd Košice",
    genitive: "Mestského súdu Košice",
  },
};

// "zapísaná v Obchodnom registri Mestského súdu Bratislava III": the wording
// after "Obchodnom registri" takes the genitive.
export const ORSR_COURT_GENITIVE_TOKEN = "court genitive" as const;

/** Preserve full names and unknown source identifiers without guessing. */
export const getOrsrCourtName = (court: string): string =>
  Object.hasOwn(COURT_NAMES, court)
    ? (COURT_NAMES[court]?.nominative ?? court)
    : court;

/** Return the known Slovak genitive form without inventing an inflection.
 *  Accepts either the insert letter the file reference carries or the full
 *  court name the extract endpoint supplies. */
export const getOrsrCourtNameGenitive = (court: string): string | null => {
  if (Object.hasOwn(COURT_NAMES, court)) {
    return COURT_NAMES[court]?.genitive ?? null;
  }

  return (
    Object.values(COURT_NAMES).find(({ nominative }) => nominative === court)
      ?.genitive ?? null
  );
};
