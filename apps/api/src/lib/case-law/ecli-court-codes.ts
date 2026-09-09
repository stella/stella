export const CZ_ECLI_COURTS = {
  KSBR: "Krajský soud v Brně",
  KSBRZL: "Krajský soud v Brně – pobočka ve Zlíně",
  KSCB: "Krajský soud v Českých Budějovicích",
  KSCBTA: "Krajský soud v Českých Budějovicích – pobočka v Táboře",
  KSHK: "Krajský soud v Hradci Králové",
  KSHKPA: "Krajský soud v Hradci Králové – pobočka v Pardubicích",
  KSOS: "Krajský soud v Ostravě",
  KSOSOL: "Krajský soud v Ostravě – pobočka v Olomouci",
  KSPH: "Krajský soud v Praze",
  KSPL: "Krajský soud v Plzni",
  KSUL: "Krajský soud v Ústí nad Labem",
  KSULLI: "Krajský soud v Ústí nad Labem – pobočka v Liberci",
  MSBR: "Městský soud v Brně",
  MSPH: "Městský soud v Praze",
  NS: "Nejvyšší soud",
  NSS: "Nejvyšší správní soud",
  OSCK: "Okresní soud v Českém Krumlově",
  OSOV: "Okresní soud v Ostravě",
  OSZR: "Okresní soud ve Žďáru nad Sázavou",
  US: "Ústavní soud",
  VSOL: "Vrchní soud v Olomouci",
  VSPH: "Vrchní soud v Praze",
} as const satisfies Readonly<Record<string, string>>;

export type CzEcliCourtCode = keyof typeof CZ_ECLI_COURTS;

export const SK_ECLI_COURTS = {
  OSBA1: "Okresný súd Bratislava I",
  OSGA: "Okresný súd Galanta",
  USSR: "Ústavný súd SR",
} as const satisfies Readonly<Record<string, string>>;

export const EU_ECLI_COURTS = {
  C: "Court of Justice",
  T: "General Court",
} as const satisfies Readonly<Record<string, string>>;
