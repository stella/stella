// French SIREN (9 digits) and SIRET (14 digits) validators.
//
// Both checksums — SIREN/SIRET Luhn plus the La Poste digit-sum
// carve-out — live in `@stll/stdnum` (which also correctly exempts the
// La Poste head office, validated by standard Luhn). We keep a local
// normalizer and shape-only check here because the dispatch layer
// routes on shape (see dispatch.ts) and the recherche-entreprises API
// is queried with the separator-free numeric form (see client.ts).
//
// SIREN reference: https://en.wikipedia.org/wiki/SIREN_code
// SIRET reference: https://www.insee.fr/fr/information/2017372

import { validate as validateSirenStdnum } from "@stll/stdnum/fr/siren";
import { validate as validateSiretStdnum } from "@stll/stdnum/fr/siret";

export const normalizeSiren = (input: string): string =>
  input.trim().replaceAll(/\s/gu, "");

export const validateSiren = (input: string): boolean =>
  validateSirenStdnum(input).valid;

export const validateSiret = (input: string): boolean =>
  validateSiretStdnum(input).valid;

// Cheap shape-only check used by the dispatch layer's `isCanonicalId`
// (which deliberately does not validate checksums — see dispatch.ts).
export const hasCanonicalShape = (input: string): boolean =>
  /^(\d{9}|\d{14})$/u.test(normalizeSiren(input));
