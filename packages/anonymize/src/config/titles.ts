/**
 * Academic and professional title prefixes.
 * Plain text; the detector auto-escapes for regex.
 * Sorted longest-first at build time.
 */
export const TITLE_PREFIXES = [
  // Czech/Slovak pre-nominal
  "Ing.",
  "Mgr.",
  "MgA.",
  "Bc.",
  "BcA.",
  "JUDr.",
  "MUDr.",
  "MVDr.",
  "MDDr.",
  "PhDr.",
  "RNDr.",
  "PaedDr.",
  "ThDr.",
  "ThLic.",
  "ICDr.",
  "RSDr.",
  "PharmDr.",
  "artD.",
  "akad.",
  "doc.",
  "prof.",

  // Professor variants (AT/DE)
  "ao. Univ.-Prof.",
  "o. Univ.-Prof.",
  "Univ.-Prof.",
  "Hon.-Prof.",
  "em. Prof.",

  // German doctoral (compound before simple)
  "Dr. med. dent.",
  "Dr. med. vet.",
  "Dr. med.",
  "Dr. rer. nat.",
  "Dr. rer. soc.",
  "Dr. rer. pol.",
  "Dr. sc. tech.",
  "Dr. sc. nat.",
  "Dr. sc. hum.",
  "Dr. iur.",
  "Dr. jur.",
  "Dr. theol.",
  "Dr. oec.",
  "Dr. techn.",
  "Dr. h. c.",
  "Dr. phil.",
  "Dr.-Ing.",
  "Dr. Ing.",
  "Dr.",

  // German Diplom variants (longest first)
  "Dipl.-Wirt.-Ing.",
  "Dipl.-Betriebsw.",
  "Dipl.-Inform.",
  "Dipl.-Volksw.",
  "Dipl.-Psych.",
  "Dipl.-Phys.",
  "Dipl.-Chem.",
  "Dipl.-Biol.",
  "Dipl.-Math.",
  "Dipl.-Päd.",
  "Dipl.-Soz.",
  "Dipl.-Kfm.",
  "Dipl.-Jur.",
  "Dipl. Ing.",
  "Dipl.-Ing.",

  // Austrian Mag/Bakk variants
  "Mag. rer. soc. oec.",
  "Mag. rer. nat.",
  "Mag. phil.",
  "Mag. iur.",
  "Mag. arch.",
  "Mag. pharm.",
  "Mag. (FH)",
  "Mag.",
  "Bakk. rer. nat.",
  "Bakk. techn.",
  "Bakk. phil.",
  "Bakk.",

  // Swiss Lic variants
  "Lic. phil.",
  "Lic. iur.",
  "Lic. oec.",
  "Lic. theol.",
  "Lic.",

  // Other German/Austrian
  "Priv.-Doz.",
  "PD",
  "RA",
] as const;

/**
 * Post-nominal degrees (comma or space separated after name).
 * Plain text; the detector auto-escapes for regex.
 */
export const POST_NOMINALS = [
  "Ph.D.",
  "CSc.",
  "DrSc.",
  "ArtD.",
  "D.Phil.",
  "DPhil.",
  "MPhil.",
  "MBA",
  "MPA",
  "LL.M.",
  "LL.B.",
  "MSc.",
  "BSc.",
  "M.Eng.",
  "B.Eng.",
  "M.A.",
  "B.A.",
  "JCD",
  "JD",
  "DiS.",
  "ACCA",
  "FCCA",
  "CIPM",
  "CIPT",
  "CIPP/E",
  "CIPP",
] as const;
