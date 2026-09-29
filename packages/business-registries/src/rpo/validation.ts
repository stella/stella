import { compact } from "@stll/stdnum/sk/ico";

const ICO_SHAPE = /^\d{8}$/u;

/**
 * Normalize a Slovak IČO: strip spaces, dashes, and other separators.
 */
export const normalizeIco = (input: string): string => compact(input);

/**
 * Whether the input is shaped like an IČO (eight digits after compacting).
 *
 * Deliberately no MOD-11 check: RPO also holds bodies registered before the
 * check digit applied (IČO 11111111, a 1992 state enterprise, fails it), and
 * those must stay reachable by their registered number.
 */
export const isIcoShape = (input: string): boolean =>
  ICO_SHAPE.test(normalizeIco(input));
