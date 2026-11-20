import { getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";
import type { InvoiceLinkDocumentType } from "./invoice-link";

export const subject = (
  lang: SupportedLang,
  {
    documentType,
    invoiceNumber,
    firmName,
  }: {
    documentType: InvoiceLinkDocumentType;
    invoiceNumber: string;
    firmName: string;
  },
) =>
  getTranslator(lang)("invoiceLink.subject", {
    documentType,
    invoiceNumber,
    firmName,
  });
