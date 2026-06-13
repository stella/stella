// Norwegian organisasjonsnummer (orgnr): 9 digits with a MOD-11 check
// digit. The checksum lives in `@stll/stdnum`; we keep a local
// normalizer because the brreg API is queried with the separator-free
// 9-digit form (see client.ts).
//
// See: https://www.brreg.no/om-oss/oppgavene-vare/registrene-vare/

import { validate } from "@stll/stdnum/no/orgnr";

export const normalizeOrgnr = (input: string): string =>
  input.replaceAll(/[\s-]/gu, "");

export const validateOrgnr = (input: string): boolean => validate(input).valid;
