// Ministry of Justice: Appendix 14, abbreviations identifying Czech courts.
// https://eudeska.justice.cz/Lists/EUD/Attachments/2270/MSP-660_2019-OSV-OSV%20-%20p%C5%99%C3%ADloha%2002.pdf
// ARES uses these abbreviations, not the longer InfoSoud court identifiers.
const COURT_NAMES: Readonly<
  Record<
    string,
    Readonly<{ nominative: string; instrumental: string; genitive: string }>
  >
> = {
  MSPH: {
    nominative: "Městský soud v Praze",
    instrumental: "Městským soudem v Praze",
    genitive: "Městského soudu v Praze",
  },
  KSPH: {
    nominative: "Krajský soud v Praze",
    instrumental: "Krajským soudem v Praze",
    genitive: "Krajského soudu v Praze",
  },
  KSCB: {
    nominative: "Krajský soud v Českých Budějovicích",
    instrumental: "Krajským soudem v Českých Budějovicích",
    genitive: "Krajského soudu v Českých Budějovicích",
  },
  KSTB: {
    nominative: "Krajský soud v Českých Budějovicích – pobočka v Táboře",
    instrumental: "Krajským soudem v Českých Budějovicích – pobočkou v Táboře",
    genitive: "Krajského soudu v Českých Budějovicích – pobočky v Táboře",
  },
  KSPL: {
    nominative: "Krajský soud v Plzni",
    instrumental: "Krajským soudem v Plzni",
    genitive: "Krajského soudu v Plzni",
  },
  KSKV: {
    nominative: "Krajský soud v Plzni – pobočka v Karlových Varech",
    instrumental: "Krajským soudem v Plzni – pobočkou v Karlových Varech",
    genitive: "Krajského soudu v Plzni – pobočky v Karlových Varech",
  },
  KSUL: {
    nominative: "Krajský soud v Ústí nad Labem",
    instrumental: "Krajským soudem v Ústí nad Labem",
    genitive: "Krajského soudu v Ústí nad Labem",
  },
  KSLB: {
    nominative: "Krajský soud v Ústí nad Labem – pobočka v Liberci",
    instrumental: "Krajským soudem v Ústí nad Labem – pobočkou v Liberci",
    genitive: "Krajského soudu v Ústí nad Labem – pobočky v Liberci",
  },
  KSHK: {
    nominative: "Krajský soud v Hradci Králové",
    instrumental: "Krajským soudem v Hradci Králové",
    genitive: "Krajského soudu v Hradci Králové",
  },
  KSPA: {
    nominative: "Krajský soud v Hradci Králové – pobočka v Pardubicích",
    instrumental: "Krajským soudem v Hradci Králové – pobočkou v Pardubicích",
    genitive: "Krajského soudu v Hradci Králové – pobočky v Pardubicích",
  },
  KSBR: {
    nominative: "Krajský soud v Brně",
    instrumental: "Krajským soudem v Brně",
    genitive: "Krajského soudu v Brně",
  },
  KSJI: {
    nominative: "Krajský soud v Brně – pobočka v Jihlavě",
    instrumental: "Krajským soudem v Brně – pobočkou v Jihlavě",
    genitive: "Krajského soudu v Brně – pobočky v Jihlavě",
  },
  KSZL: {
    nominative: "Krajský soud v Brně – pobočka ve Zlíně",
    instrumental: "Krajským soudem v Brně – pobočkou ve Zlíně",
    genitive: "Krajského soudu v Brně – pobočky ve Zlíně",
  },
  KSOS: {
    nominative: "Krajský soud v Ostravě",
    instrumental: "Krajským soudem v Ostravě",
    genitive: "Krajského soudu v Ostravě",
  },
  KSOL: {
    nominative: "Krajský soud v Ostravě – pobočka v Olomouci",
    instrumental: "Krajským soudem v Ostravě – pobočkou v Olomouci",
    genitive: "Krajského soudu v Ostravě – pobočky v Olomouci",
  },
  VSPH: {
    nominative: "Vrchní soud v Praze",
    instrumental: "Vrchním soudem v Praze",
    genitive: "Vrchního soudu v Praze",
  },
  VSOL: {
    nominative: "Vrchní soud v Olomouci",
    instrumental: "Vrchním soudem v Olomouci",
    genitive: "Vrchního soudu v Olomouci",
  },
  NSCR: {
    nominative: "Nejvyšší soud",
    instrumental: "Nejvyšším soudem",
    genitive: "Nejvyššího soudu",
  },
};

export const ARES_COURT_INSTRUMENTAL_TOKEN = "court instrumental" as const;

// "u Městského soudu v Praze": the wording after "u" takes the genitive.
export const ARES_COURT_GENITIVE_TOKEN = "court genitive" as const;

/** Preserve full names and unknown source identifiers without guessing. */
export const getAresCourtName = (court: string): string =>
  Object.hasOwn(COURT_NAMES, court)
    ? (COURT_NAMES[court]?.nominative ?? court)
    : court;

/** Return the known Czech instrumental form without inventing an inflection. */
export const getAresCourtNameInstrumental = (court: string): string | null => {
  if (Object.hasOwn(COURT_NAMES, court)) {
    return COURT_NAMES[court]?.instrumental ?? null;
  }

  return (
    Object.values(COURT_NAMES).find(({ nominative }) => nominative === court)
      ?.instrumental ?? null
  );
};

/** Return the known Czech genitive form without inventing an inflection. */
export const getAresCourtNameGenitive = (court: string): string | null => {
  if (Object.hasOwn(COURT_NAMES, court)) {
    return COURT_NAMES[court]?.genitive ?? null;
  }

  return (
    Object.values(COURT_NAMES).find(({ nominative }) => nominative === court)
      ?.genitive ?? null
  );
};
