// French SIREN (9 digits) and SIRET (14 digits) validators.
//
// Both identifiers carry a Luhn (MOD-10) check digit in their final
// position. SIRET = SIREN (9) + NIC (5); the Luhn checksum runs over
// the full 9-digit SIREN for SIREN validation and over the full
// 14-digit SIRET for SIRET validation.
//
// Two notable carve-outs of the SIRET checksum:
//
// - La Poste's SIREN 356000000 has a true Luhn-valid SIREN but every
//   SIRET allocated under it intentionally fails Luhn. INSEE's
//   documented workaround is to validate La Poste SIRETs by summing
//   the 14 digits and checking divisibility by 5. We implement the
//   carve-out so government / utility entities owned by La Poste do
//   not surface as "invalid SIRET".
// - "Monégasque" SIRENs in the 998xxxxxx and 999xxxxxx ranges are
//   reserved for Monaco; they do follow Luhn so no special handling.
//
// SIREN reference: https://en.wikipedia.org/wiki/SIREN_code
// SIRET reference: https://www.insee.fr/fr/information/2017372
// La Poste carve-out reference:
// https://fr.wikipedia.org/wiki/Système_d%27identification_du_répertoire_des_établissements
//   ("Notation des SIRET de La Poste")

const LA_POSTE_SIREN = "356000000";

export const normalizeSiren = (input: string): string =>
  input.trim().replaceAll(/\s/gu, "");

const luhnValid = (digits: string): boolean => {
  // Standard Luhn (right-to-left, double every second digit).
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const reverseIndex = digits.length - 1 - i;
    const ch = digits[reverseIndex];
    if (ch === undefined) {
      return false;
    }
    let digit = Number(ch);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
};

export const validateSiren = (input: string): boolean => {
  const compact = normalizeSiren(input);
  if (!/^\d{9}$/u.test(compact)) {
    return false;
  }
  return luhnValid(compact);
};

export const validateSiret = (input: string): boolean => {
  const compact = normalizeSiren(input);
  if (!/^\d{14}$/u.test(compact)) {
    return false;
  }
  // La Poste carve-out: every SIRET under SIREN 356000000 must satisfy
  // "sum of 14 digits divisible by 5" instead of Luhn.
  if (compact.startsWith(LA_POSTE_SIREN)) {
    let total = 0;
    for (const ch of compact) {
      total += Number(ch);
    }
    return total % 5 === 0;
  }
  return luhnValid(compact);
};

// Cheap shape-only check used by the dispatch layer's `isCanonicalId`
// (which deliberately does not validate checksums — see dispatch.ts).
export const hasCanonicalShape = (input: string): boolean =>
  /^(\d{9}|\d{14})$/u.test(normalizeSiren(input));
