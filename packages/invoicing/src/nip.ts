// Polish NIP (numer identyfikacji podatkowej): ten digits, the last the
// mod-11 checksum of the first nine. Kept here rather than taken from a
// validator library: the web app and the API schema graph import this
// package, and neither may pull a WASM-backed module.

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7] as const;

/**
 * The ten NIP digits of a tax ID as people write it ("PL 526-000-12-46"),
 * or null when it is not a valid NIP.
 */
export const parseNip = (value: string): string | null => {
  const compact = value
    .replaceAll(/[\s-]/gu, "")
    .toUpperCase()
    .replace(/^PL/u, "");
  if (!/^\d{10}$/u.test(compact)) {
    return null;
  }
  const digits = Array.from(compact, Number);
  const sum = NIP_WEIGHTS.reduce(
    (total, weight, index) => total + weight * (digits[index] ?? 0),
    0,
  );
  const check = sum % 11;
  return check !== 10 && check === digits[9] ? compact : null;
};
