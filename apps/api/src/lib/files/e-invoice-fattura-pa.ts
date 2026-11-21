import type { EInvoice } from "@stll/api-contract/e-invoice";

import {
  addressLines,
  at,
  attributeOf,
  capLines,
  childrenOf,
  joined,
  type ParsedEInvoice,
  textAt,
  textOf,
} from "@/api/lib/files/e-invoice-nodes";
import type { DocumentXmlNode } from "@/api/lib/files/xml-document-package";

// FatturaPA 1.2.x ordinary invoice ("Specifiche tecniche del formato
// FatturaPA", Agenzia delle Entrate). One header names the parties; each
// `FatturaElettronicaBody` is one invoice of the batch.

// TipoDocumento codes: TD01 invoice, TD02 and TD03 advances, TD04 credit
// note, TD05 debit note, TD06 fee note, TD24 to TD27 deferred and
// self-issued invoices. Other codes are shown as their own code.
const documentTypeOf = (code: string | null): EInvoice["documentType"] => {
  switch (code) {
    case "TD01":
    case "TD06":
    case "TD24":
    case "TD25":
    case "TD26":
    case "TD27":
      return "invoice";
    case "TD02":
    case "TD03":
      return "advance";
    case "TD04":
      return "creditNote";
    case "TD05":
      return "debitNote";
    default:
      return "other";
  }
};

const party = (node: DocumentXmlNode | undefined): EInvoice["seller"] => {
  const details = at(node, "DatiAnagrafici");
  const registry = at(details, "Anagrafica");
  const office = at(node, "Sede");
  const vatId = at(details, "IdFiscaleIVA");
  const vatNumber = joined(
    "",
    textAt(vatId, "IdPaese"),
    textAt(vatId, "IdCodice"),
  );
  const taxCode = textAt(details, "CodiceFiscale");
  const province = textAt(office, "Provincia");
  return {
    name:
      textAt(registry, "Denominazione") ??
      joined(
        " ",
        textAt(registry, "Titolo"),
        textAt(registry, "Nome"),
        textAt(registry, "Cognome"),
      ),
    identifiers: [
      ...(vatNumber === null
        ? []
        : [{ kind: "vat" as const, scheme: "IdFiscaleIVA", value: vatNumber }]),
      ...(taxCode === null
        ? []
        : [{ kind: "tax" as const, scheme: "CodiceFiscale", value: taxCode }]),
    ],
    address: addressLines(
      joined(" ", textAt(office, "Indirizzo"), textAt(office, "NumeroCivico")),
      joined(
        " ",
        textAt(office, "CAP"),
        textAt(office, "Comune"),
        province === null ? null : `(${province})`,
      ),
      textAt(office, "Nazione"),
    ),
  };
};

export const readFatturaPaInvoice = (root: DocumentXmlNode): ParsedEInvoice => {
  const header = at(root, "FatturaElettronicaHeader");
  const seller = party(at(header, "CedentePrestatore"));
  const buyer = party(at(header, "CessionarioCommittente"));
  const bodies = childrenOf(root, "FatturaElettronicaBody");
  const invoices = bodies.map((body): EInvoice => {
    const general = at(body, "DatiGenerali", "DatiGeneraliDocumento");
    const goods = at(body, "DatiBeniServizi");
    const lines = childrenOf(goods, "DettaglioLinee");
    const payments = childrenOf(body, "DatiPagamento").flatMap((terms) =>
      childrenOf(terms, "DettaglioPagamento"),
    );
    const typeCode = textAt(general, "TipoDocumento");
    return {
      documentType: documentTypeOf(typeCode),
      typeCode,
      number: textAt(general, "Numero"),
      issueDate: textAt(general, "Data"),
      taxPointDate: null,
      dueDate:
        payments
          .map((payment) => textAt(payment, "DataScadenzaPagamento"))
          .find((date) => date !== null) ?? null,
      currency: textAt(general, "Divisa"),
      seller,
      buyer,
      lines: capLines(
        lines.map((line) => ({
          id: textAt(line, "NumeroLinea"),
          description: textAt(line, "Descrizione"),
          quantity: textAt(line, "Quantita"),
          unitCode: textAt(line, "UnitaMisura"),
          unitPrice: textAt(line, "PrezzoUnitario"),
          vatRate: textAt(line, "AliquotaIVA"),
          vatCategory: textAt(line, "Natura"),
          netAmount: textAt(line, "PrezzoTotale"),
        })),
      ),
      lineCount: lines.length,
      vatBreakdown: childrenOf(goods, "DatiRiepilogo").map((summary) => ({
        rate: textAt(summary, "AliquotaIVA"),
        category: textAt(summary, "Natura"),
        taxableAmount: textAt(summary, "ImponibileImporto"),
        taxAmount: textAt(summary, "Imposta"),
        exemptionReason: textAt(summary, "RiferimentoNormativo"),
      })),
      // The format states only the document total; its parts are per rate.
      totals: {
        netAmount: null,
        taxAmount: null,
        grossAmount: textAt(general, "ImportoTotaleDocumento"),
        prepaidAmount: null,
        payableAmount: null,
      },
      payments: payments.map((payment) => ({
        meansCode: textAt(payment, "ModalitaPagamento"),
        dueDate: textAt(payment, "DataScadenzaPagamento"),
        amount: textAt(payment, "ImportoPagamento"),
        iban: textAt(payment, "IBAN"),
        bic: textAt(payment, "BIC"),
        accountNumber: null,
        bankCode: null,
        reference: textAt(payment, "CodicePagamento"),
      })),
      notes: childrenOf(general, "Causale").flatMap(
        (reason) => textOf(reason) ?? [],
      ),
    };
  });
  return {
    version: attributeOf(root, "versione"),
    invoices,
    embedded: bodies.flatMap((body) =>
      childrenOf(body, "Allegati").flatMap((attachment) => {
        const base64 = at(attachment, "Attachment")?.text ?? "";
        const fileName = textAt(attachment, "NomeAttachment");
        return fileName === null || base64.trim() === ""
          ? []
          : [
              {
                fileName,
                description: textAt(attachment, "DescrizioneAttachment"),
                base64,
              },
            ];
      }),
    ),
  };
};
