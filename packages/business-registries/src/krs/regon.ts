import { validate as validateRegon } from "@stll/stdnum/pl/regon";

const PADDED_REGON_RE = /^(?<base>\d{9})00000$/u;

/**
 * The KRS API right-pads a nine-digit REGON to fourteen characters
 * ("492707333" arrives as "49270733300000"). That is not a fourteen-digit
 * local-unit REGON, so putting it into a contract states a number that does
 * not exist.
 *
 * Two facts make the padding safe to strip here. The field is the entity's own
 * identifier (`dzial1.danePodmiotu.identyfikatory`), so a local unit's REGON
 * cannot legitimately appear in it; and in a real fourteen-digit REGON the
 * four digits after the base identify the local unit, which is numbered from
 * 0001 — an all-zero unit segment is never assigned. The checksum cannot carry
 * this decision on its own: "35052737700000" (Comarch) satisfies the
 * fourteen-digit check digit by coincidence while still being padding.
 *
 * Anything else — nine digits already, a genuine local-unit REGON, a malformed
 * value — is returned untouched, which also makes this idempotent.
 *
 * https://stat.gov.pl/metainformacje/slownik-pojec/pojecia-stosowane-w-statystyce-publicznej/2963,pojecie.html
 */
export const normalizeRegon = (regon: string): string => {
  const base = PADDED_REGON_RE.exec(regon)?.groups?.["base"];
  if (base === undefined) {
    return regon;
  }
  return validateRegon(base).valid ? base : regon;
};
