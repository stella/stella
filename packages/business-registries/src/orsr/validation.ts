import { compact, validate } from "@stll/stdnum/sk/ico";

// Slovak IČO. Same 8-digit, MOD-11 scheme as the Czech IČO (both
// inherit from the pre-1993 Czechoslovak register), so `@stll/stdnum`
// re-exports the Czech validator under `sk/ico`.

/**
 * Normalize a Slovak IČO: strip spaces, dashes, and other separators.
 */
export const normalizeIco = (input: string): string => compact(input);

/**
 * Validate a Slovak IČO using `@stll/stdnum`.
 * Requires exactly 8 digits after compacting + the MOD-11 check digit.
 */
export const validateIco = (input: string): boolean => validate(input).valid;
