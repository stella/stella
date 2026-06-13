// 統一編號 (tongbian / Business Administration Number) — Taiwanese
// 8-digit company tax ID used by GCIS as the canonical identifier. The
// weighted check-digit algorithm (including the 7th-digit-is-7
// fallback) lives in `@stll/stdnum`; we keep a local normalizer because
// the GCIS API is queried with the separator-free 8-digit form (see
// client.ts).
//
// Reference: Ministry of Finance, 統一編號 issuance manual.

import { validate } from "@stll/stdnum/tw/ubn";

export const normalizeTaxId = (input: string): string =>
  input.trim().replaceAll(/[\s-]/gu, "");

export const validateTaxId = (input: string): boolean => validate(input).valid;
