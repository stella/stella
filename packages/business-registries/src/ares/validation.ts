import { compact, validate } from "@stll/stdnum/cz/ico";

/**
 * Normalize an IČO: strip spaces and dashes.
 */
export const normalizeIco = (input: string): string => compact(input);

/**
 * Validate a Czech IČO using `@stll/stdnum`.
 * Requires exactly 8 digits after compacting.
 */
export const validateIco = (input: string): boolean => validate(input).valid;
