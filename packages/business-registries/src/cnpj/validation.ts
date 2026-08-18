import { compact, validate } from "@stll/stdnum/br/cnpj";

/**
 * Normalize a CNPJ: strip formatting punctuation, keep only digits.
 */
export const normalizeCnpj = (input: string): string => compact(input);

/**
 * Validate a Brazilian CNPJ using `@stll/stdnum` (module-11 check digits).
 * Requires exactly 14 digits after compacting.
 */
export const validateCnpj = (input: string): boolean => validate(input).valid;
