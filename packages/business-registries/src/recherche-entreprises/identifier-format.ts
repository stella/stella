export const SIREN_SPACED_TOKEN = "SIREN spaced" as const;
export const SIRET_SPACED_TOKEN = "SIRET spaced" as const;

const NINE_DIGITS_RE = /^\d{9}$/u;
const FOURTEEN_DIGITS_RE = /^\d{14}$/u;

/** French practice groups the nine-digit SIREN as "ddd ddd ddd", the grouping
 *  INSEE and the RCS clause of a party-identification recital both use.
 *  Anything else is returned untouched, which also makes it idempotent.
 *
 *  https://www.insee.fr/fr/information/1972062 */
export const formatSirenSpaced = (siren: string): string =>
  NINE_DIGITS_RE.test(siren)
    ? `${siren.slice(0, 3)} ${siren.slice(3, 6)} ${siren.slice(6)}`
    : siren;

/** The fourteen-digit SIRET is the SIREN plus the five-digit NIC, and is
 *  grouped to match: "ddd ddd ddd ddddd". */
export const formatSiretSpaced = (siret: string): string =>
  FOURTEEN_DIGITS_RE.test(siret)
    ? `${siret.slice(0, 3)} ${siret.slice(3, 6)} ${siret.slice(6, 9)} ${siret.slice(9)}`
    : siret;
