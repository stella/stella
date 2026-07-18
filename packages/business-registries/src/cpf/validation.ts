import { compact, validate } from "@stll/stdnum/br/cpf";

/**
 * Normalize a CPF: strip formatting punctuation, keep only digits.
 */
export const normalizeCpf = (input: string): string => compact(input);

/**
 * Validate a Brazilian CPF using `@stll/stdnum` (module-11 check digits).
 * Requires exactly 11 digits after compacting.
 */
export const validateCpf = (input: string): boolean => validate(input).valid;
