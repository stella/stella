// French SIREN (9 digits) and SIRET (14 digits) validators.
//
// Both checksums — SIREN/SIRET Luhn plus the La Poste digit-sum
// carve-out — live in `@stll/stdnum` (which also correctly exempts the
// La Poste head office, validated by standard Luhn). normalizeSiren
// reuses stdnum's `compact` so the canonical form matches exactly what
// the validators accept: a valid spaced or dotted id collapses to the
// digits used for the API query and exact-match (see client.ts), and
// the shape check stays in sync with validation.
//
// SIREN reference: https://en.wikipedia.org/wiki/SIREN_code
// SIRET reference: https://www.insee.fr/fr/information/2017372

import {
  compact,
  validate as validateSirenStdnum,
} from "@stll/stdnum/fr/siren";
import { validate as validateSiretStdnum } from "@stll/stdnum/fr/siret";

export const normalizeSiren = (input: string): string => compact(input);

export const validateSiren = (input: string): boolean =>
  validateSirenStdnum(input).valid;

export const validateSiret = (input: string): boolean =>
  validateSiretStdnum(input).valid;

// Cheap shape-only check used by the dispatch layer's `isCanonicalId`
// (which deliberately does not validate checksums — see dispatch.ts).
export const hasCanonicalShape = (input: string): boolean =>
  /^(\d{9}|\d{14})$/u.test(normalizeSiren(input));
