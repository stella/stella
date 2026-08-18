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

export const fingerprintContactImport = (rows: readonly unknown[]): string =>
  new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        version: CONTACT_IMPORT_RECEIPT_VERSION,
        rows,
      }),
    )
    .digest("hex");
