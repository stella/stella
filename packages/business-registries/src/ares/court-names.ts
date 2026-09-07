// Ministry of Justice: Appendix 14, abbreviations identifying Czech courts.
// https://eudeska.justice.cz/Lists/EUD/Attachments/2270/MSP-660_2019-OSV-OSV%20-%20p%C5%99%C3%ADloha%2002.pdf
// ARES uses these abbreviations, not the longer InfoSoud court identifiers.
const COURT_NAMES: Readonly<Record<string, string>> = {
  MSPH: "Městský soud v Praze",
  KSPH: "Krajský soud v Praze",
  KSCB: "Krajský soud v Českých Budějovicích",
  KSTB: "Krajský soud v Českých Budějovicích – pobočka v Táboře",
  KSPL: "Krajský soud v Plzni",
  KSKV: "Krajský soud v Plzni – pobočka v Karlových Varech",
  KSUL: "Krajský soud v Ústí nad Labem",
  KSLB: "Krajský soud v Ústí nad Labem – pobočka v Liberci",
  KSHK: "Krajský soud v Hradci Králové",
  KSPA: "Krajský soud v Hradci Králové – pobočka v Pardubicích",
  KSBR: "Krajský soud v Brně",
  KSJI: "Krajský soud v Brně – pobočka v Jihlavě",
  KSZL: "Krajský soud v Brně – pobočka ve Zlíně",
  KSOS: "Krajský soud v Ostravě",
  KSOL: "Krajský soud v Ostravě – pobočka v Olomouci",
  VSPH: "Vrchní soud v Praze",
  VSOL: "Vrchní soud v Olomouci",
  NSCR: "Nejvyšší soud",
};

/** Preserve full names and unknown source identifiers without guessing. */
export const getAresCourtName = (court: string): string =>
  Object.hasOwn(COURT_NAMES, court) ? (COURT_NAMES[court] ?? court) : court;
