import type { CourtTierLabel } from "./case-law-court-tiers";

/** Localized court-tier labels shared by clients and sandbox charts. */
export const COURT_TIER_LOCALIZED_LABELS = {
  ar: {
    constitutional: "المحاكم الدستورية",
    other: "المحاكم الأخرى",
    regional: "محاكم الاستئناف والمحاكم الإقليمية",
    supreme: "المحاكم العليا",
  },
  cs: {
    constitutional: "Ústavní soudy",
    other: "Ostatní soudy",
    regional: "Krajské a vrchní soudy",
    supreme: "Nejvyšší soudy",
  },
  de: {
    constitutional: "Verfassungsgerichte",
    other: "Übrige Gerichte",
    regional: "Ober- und Landesgerichte",
    supreme: "Oberste Gerichte",
  },
  en: {
    constitutional: "Constitutional courts",
    other: "Other courts",
    regional: "High and regional courts",
    supreme: "Supreme courts",
  },
  es: {
    constitutional: "Tribunales constitucionales",
    other: "Otros tribunales",
    regional: "Audiencias y tribunales regionales",
    supreme: "Tribunales supremos",
  },
  et: {
    constitutional: "Põhiseaduslikkuse järelevalve kohtud",
    other: "Muud kohtud",
    regional: "Ringkonnakohtud",
    supreme: "Riigikohtud",
  },
  fr: {
    constitutional: "Juridictions constitutionnelles",
    other: "Autres juridictions",
    regional: "Cours d'appel et tribunaux régionaux",
    supreme: "Juridictions suprêmes",
  },
  hu: {
    constitutional: "Alkotmánybíróságok",
    other: "Egyéb bíróságok",
    regional: "Ítélőtáblák és törvényszékek",
    supreme: "Legfelsőbb bíróságok",
  },
  lt: {
    constitutional: "Konstituciniai teismai",
    other: "Kiti teismai",
    regional: "Apeliaciniai ir apygardų teismai",
    supreme: "Aukščiausieji teismai",
  },
  lv: {
    constitutional: "Konstitucionālās tiesas",
    other: "Citas tiesas",
    regional: "Apgabaltiesas",
    supreme: "Augstākās tiesas",
  },
  pl: {
    constitutional: "Trybunały konstytucyjne",
    other: "Pozostałe sądy",
    regional: "Sądy apelacyjne i okręgowe",
    supreme: "Sądy najwyższe",
  },
  "pt-BR": {
    constitutional: "Tribunais constitucionais",
    other: "Demais tribunais",
    regional: "Tribunais regionais e de justiça",
    supreme: "Tribunais superiores",
  },
  sk: {
    constitutional: "Ústavné súdy",
    other: "Ostatné súdy",
    regional: "Krajské súdy",
    supreme: "Najvyššie súdy",
  },
} as const satisfies Record<string, Record<CourtTierLabel, string>>;
