import { compact, validate } from "@stll/stdnum/sk/ico";

/**
 * Normalize a Slovak IČO: strip spaces and dashes.
 *
 * SK and CZ IČO share the same 8-digit MOD-11 algorithm (both inherit
 * from the pre-1993 Czechoslovak register), so `@stll/stdnum/sk/ico`
 * re-exports the CZ validator unchanged. We re-export under the rpo
 * namespace so callers do not have to know about the CZ origin.
 */
export const normalizeIco = (input: string): string => compact(input);

/**
 * Validate a Slovak IČO using `@stll/stdnum`.
 * Requires exactly 8 digits after compacting plus a valid MOD-11
 * checksum on the first seven digits.
 */
export const validateIco = (input: string): boolean => validate(input).valid;
