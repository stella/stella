/**
 * PLACEHOLDER content for the law home's recent-searches and signals columns
 * while their feeds are designed. Untranslated and static on purpose; it is
 * replaced by the real feeds before the home ships.
 */

export type PlaceholderRecentSearch = {
  query: string;
  when: string;
};

export const PLACEHOLDER_RECENT_SEARCHES: readonly PlaceholderRecentSearch[] = [
  { query: "náhrada nemajetkové újmy", when: "dnes" },
  { query: "22 Cdo 2653/2012", when: "včera" },
  { query: "§ 2079 89/2012 Sb.", when: "včera" },
  { query: "promlčení bezdůvodného obohacení", when: "před 3 dny" },
  { query: "ECLI:CZ:NS:2012:23.CDO.1572.2012.1", when: "minulý týden" },
];

export type PlaceholderDatabaseStatus = {
  entries: number;
  updatedAt: string;
};

export const PLACEHOLDER_DATABASE_STATUS: PlaceholderDatabaseStatus = {
  entries: 3_841_072,
  updatedAt: "2026-09-02T15:45:00Z",
};

export type PlaceholderSignal = {
  title: string;
  meta: string;
};

export const PLACEHOLDER_SIGNALS: readonly PlaceholderSignal[] = [
  {
    title: "Novela zákoníku práce nabývá účinnosti",
    meta: "262/2006 Sb. · od 1. 1. 2027",
  },
  {
    title: "Ústavní soud zrušil část zákona o pobytu cizinců",
    meta: "Pl. ÚS 12/26 · dnes",
  },
  {
    title: "Sjednocující stanovisko NS k promlčení",
    meta: "Cpjn 201/2025 · včera",
  },
  {
    title: "Rozšířený senát NSS k daňovým lhůtám",
    meta: "1 Afs 40/2025 · před 3 dny",
  },
  {
    title: "Vyhláška 99/2026 Sb. vstoupila v účinnost",
    meta: "1. 9. 2026",
  },
];
