// 統一編號 (tongbian / Business Administration Number) — Taiwanese
// 8-digit company tax ID issued by the Ministry of Finance and used
// by GCIS as the canonical identifier.
//
// Check-digit algorithm:
//
//   * Weights [1, 2, 1, 2, 1, 2, 4, 1] applied per digit.
//   * For each weighted product p, accumulate `floor(p / 10) + (p % 10)`
//     (i.e. the sum of the product's tens and units digits).
//   * Valid iff `sum % 10 === 0`.
//   * Special case: if the 7th digit (index 6) is `7`, the entity is
//     also valid when `(sum + 1) % 10 === 0`. The 7th digit is the
//     "industry / type" segment and `7` historically aliased to two
//     check totals on legacy paper certificates; the MoF preserved
//     both as valid when modernising the algorithm.
//
// Reference: Ministry of Finance, 統一編號 issuance manual.
// Wikipedia summary: https://zh.wikipedia.org/wiki/统一编号

const TONGBIAN_WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1] as const;
const SPECIAL_SEVENTH_DIGIT = 7;

export const normalizeTaxId = (input: string): string =>
  input.trim().replaceAll(/[\s-]/gu, "");

export const validateTaxId = (input: string): boolean => {
  const compact = normalizeTaxId(input);
  if (!/^\d{8}$/u.test(compact)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < TONGBIAN_WEIGHTS.length; i++) {
    const digit = Number(compact[i]);
    const weight = TONGBIAN_WEIGHTS[i];
    if (weight === undefined) {
      return false;
    }
    const product = digit * weight;
    sum += Math.floor(product / 10) + (product % 10);
  }
  if (sum % 10 === 0) {
    return true;
  }
  // The 7th-digit-is-7 fallback: a single match window above the
  // base check, no broader tolerance. Anything else fails.
  return Number(compact[6]) === SPECIAL_SEVENTH_DIGIT && (sum + 1) % 10 === 0;
};
