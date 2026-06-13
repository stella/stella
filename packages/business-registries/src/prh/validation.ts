// Finnish Y-tunnus (business ID), canonical format `NNNNNNN-C`.
//
// The MOD-11 checksum lives in `@stll/stdnum`. We keep the hyphenated-
// format check locally: unlike stdnum (which also accepts the bare
// 8-digit form), this adapter requires `NNNNNNN-C` because the PRH API
// is queried with the hyphenated id (see client.ts).
//
// PRH spec: https://www.vero.fi/en/businesses-and-corporations/about-corporate-taxes/business-id/

import { validate } from "@stll/stdnum/fi/ytunnus";

const YTUNNUS_FORMAT = /^\d{7}-\d$/u;

export const normalizeBusinessId = (input: string): string =>
  input.trim().replaceAll(/\s/gu, "");

export const validateBusinessId = (input: string): boolean =>
  YTUNNUS_FORMAT.test(normalizeBusinessId(input)) && validate(input).valid;
