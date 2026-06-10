import type { CourtMap } from "./types.js";

export const DEFAULT_BASE_URL = "https://infosoud.gov.cz/api/v1";
export const DEFAULT_DELAY_MS = 500;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_USER_AGENT =
  "infosoud/0.1.0 (+https://github.com/stella/stella/tree/main/packages/infosoud)";
export const DEFAULT_CASE_CACHE_TTL_MS: number = 6 * 60 * 60 * 1000;
export const DEFAULT_HEARINGS_CACHE_TTL_MS: number = 60 * 60 * 1000;
export const DEFAULT_EVENT_DETAIL_CACHE_TTL_MS: number = 6 * 60 * 60 * 1000;
export const DEFAULT_COURTS_CACHE_TTL_MS: number = 24 * 60 * 60 * 1000;
export const DEFAULT_DERIVED_COURT_MAP_CACHE_TTL_MS: number =
  DEFAULT_COURTS_CACHE_TTL_MS;

export const NS_CASE_TYPES: ReadonlySet<string> = new Set([
  "CDO",
  "ICM",
  "NCU",
  "NSCR",
  "ODO",
  "TKCDO",
  "TDO",
  "TZ",
]);

export const PRAGUE_DISTRICT_CODES: readonly string[] = Array.from(
  { length: 10 },
  (_, index) => `OSPHA${String(index + 1).padStart(2, "0")}`,
);

export const COURT_CODE_ALIASES: Record<string, string> = {
  KSSEMOC: "KSSEMOS",
  VSSTCAB: "VSPHAAB",
};

export const EXTRA_COURTS: CourtMap = {
  KSSCELB: "Krajský soud Ústí nad Labem – pobočka Liberec",
  KSSEMOC: "Krajský soud Ostrava – pobočka Olomouc",
  KSVYCPA: "Krajský soud Hradec Králové – pobočka Pardubice",
  NS: "Nejvyšší soud",
  OSSEMBH: "Okresní soud v Bohumíně (zrušen)",
  OSJIMJR: "Okresní soud v Jaroslavicích (zrušen)",
  OSJIMLH: "Okresní soud v Luhačovicích (zrušen)",
  OSJIMVI: "Okresní soud ve Vizovicích (zrušen)",
  OSSEMOD: "Okresní soud v Odrách (zrušen)",
  OSSEMHA: "Okresní soud Karviná – pobočka Havířov",
  OSSEMKR: "Okresní soud Bruntál – pobočka Krnov",
  OSSEMVM: "Okresní soud Vsetín – pobočka Valašské Meziříčí",
  VSSEMOC: "Vrchní soud Olomouc",
  VSSTCAB: "Vrchní soud Praha",
};

export const DEFAULT_EVENT_DETAIL_EVENT_TYPES = [
  "NAR_JED",
  "ZRUS_JED",
] as const;

export const COURT_PREFIXES: readonly string[] = [
  "ks",
  "krajsky soud",
  "ms",
  "mestsky soud",
  "ns",
  "nejvyssi soud",
  "obvodni",
  "obvodni soud",
  "os",
  "okresni",
  "okresni soud",
  "vs",
  "vrchni soud",
];

export const COURT_GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "krajsky",
  "ks",
  "mestsky",
  "ms",
  "nejvyssi",
  "ns",
  "obvodni",
  "okresni",
  "os",
  "pobocka",
  "soud",
  "soudni",
  "vrchni",
  "vs",
  "v",
  "ve",
]);
