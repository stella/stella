import { validateCnpj } from "@stll/business-registries/cnpj";
import { validateCpf } from "@stll/business-registries/cpf";

const CONTACT_IMPORT_RECEIPT_VERSION = 1;

const onlyDigits = (value: string): string => value.replaceAll(/\D/gu, "");

export const classifyBrazilianTaxId = (
  taxId: string,
): { digits: string; type: "person" | "organization" } | null => {
  const digits = onlyDigits(taxId);
  if (digits.length === 11 && validateCpf(digits)) {
    return { digits, type: "person" };
  }
  if (digits.length === 14 && validateCnpj(digits)) {
    return { digits, type: "organization" };
  }
  return null;
};

/**
 * JSON with object keys sorted at every depth, so two payloads that differ
 * only in property order serialize identically. `JSON.stringify` alone would
 * fingerprint a rebuilt-but-equal retry as a different request.
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const fingerprintContactImport = (rows: readonly unknown[]): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonicalJson({ version: CONTACT_IMPORT_RECEIPT_VERSION, rows }))
    .digest("hex");
