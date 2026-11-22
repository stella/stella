import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import type {
  E_INVOICE_DOCUMENT_TYPES,
  E_INVOICE_IDENTIFIER_KINDS,
  E_INVOICE_SYNTAXES,
  EInvoice,
  EInvoicePreview,
} from "@stll/api-contract/e-invoice";
import { BidiText } from "@stll/ui/bidi-text";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { DocumentMark, type DocumentMarkKind } from "@stll/ui/document-mark";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { FilePartList } from "@/components/file-parts/file-parts";
import type { FilePartActions } from "@/components/file-parts/use-file-part-actions";
import type { TranslationKey } from "@/i18n/types";

type Syntax = (typeof E_INVOICE_SYNTAXES)[number];

/** Format names are proper names and stay as their specifications write them. */
const SYNTAX_LABELS = {
  cii: "CII",
  fatturaPA: "FatturaPA",
  isdoc: "ISDOC",
  ubl: "UBL",
} as const satisfies Record<Syntax, string>;

const SYNTAX_MARKS = {
  cii: "xml",
  fatturaPA: "fatturaPA",
  isdoc: "isdoc",
  ubl: "xml",
} as const satisfies Record<Syntax, DocumentMarkKind>;

const IDENTIFIER_KIND_LABELS = {
  other: "eInvoice.otherIdentifier",
  registration: "common.anonymizationLabels.registrationNumber",
  tax: "common.taxId",
  vat: "common.vatId",
} as const satisfies Record<
  (typeof E_INVOICE_IDENTIFIER_KINDS)[number],
  TranslationKey
>;

// The select keys the numbered title's message branches on.
const DOCUMENT_TYPES = {
  advance: "advance",
  creditNote: "creditNote",
  debitNote: "debitNote",
  invoice: "invoice",
  other: "other",
} as const satisfies {
  [Type in (typeof E_INVOICE_DOCUMENT_TYPES)[number]]: Type;
};

// An unnumbered document is titled by its type alone.
const DOCUMENT_TYPE_LABELS = {
  advance: "eInvoice.documentTypes.advance",
  creditNote: "billing.numberSeries.creditNote",
  debitNote: "eInvoice.documentTypes.debitNote",
  invoice: "billing.numberSeries.invoice",
  other: "eInvoice.documentTypes.other",
} as const satisfies Record<
  (typeof E_INVOICE_DOCUMENT_TYPES)[number],
  TranslationKey
>;

type Party = EInvoice["seller"];

/**
 * What the file lists without ids (lines, notes, a batch's invoices) is keyed
 * by its content and the how-manieth time that content repeats, so a row keeps
 * its key while the file stays the same.
 */
const keyed = <Item,>(
  items: readonly Item[],
  identity: (item: Item) => unknown = (item) => item,
) => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const content = JSON.stringify(identity(item));
    const occurrence = (seen.get(content) ?? 0) + 1;
    seen.set(content, occurrence);
    return { item, key: `${content}#${occurrence}` };
  });
};

const Amount = ({
  amount,
  currency,
}: {
  amount: string;
  currency: string | null;
}) => {
  const t = useTranslations();
  return (
    <bdi className="tabular-nums">
      {currency === null
        ? amount
        : t("eInvoice.amountWithCurrency", { amount, currency })}
    </bdi>
  );
};

const Rate = ({
  category,
  rate,
}: {
  category: string | null;
  rate: string | null;
}) => {
  const t = useTranslations();
  if (rate === null) {
    return category === null ? null : <bdi>{category}</bdi>;
  }
  return (
    <bdi className="tabular-nums">
      {category === null
        ? t("eInvoice.ratePercent", { rate })
        : t("eInvoice.ratePercentWithCategory", { category, rate })}
    </bdi>
  );
};

/** The quantity a price is for, as the file writes it ("100 C62"). */
const PricedPer = ({ basis }: { basis: string }) => <bdi>{` / ${basis}`}</bdi>;

const Section = ({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) => (
  <section className="space-y-2">
    <h3 className="text-sm font-medium">{title}</h3>
    {children}
  </section>
);

const PartyDetails = ({ party, title }: { party: Party; title: string }) => {
  const t = useTranslations();
  if (
    party.name === null &&
    party.identifiers.length === 0 &&
    party.address.length === 0
  ) {
    return null;
  }
  return (
    <Section title={title}>
      {party.name !== null && (
        <BidiText as="p" className="text-sm font-medium wrap-break-word">
          {party.name}
        </BidiText>
      )}
      {party.identifiers.length > 0 && (
        <DetailsGrid variant="list">
          {keyed(party.identifiers).map(({ item: identifier, key }) => {
            const kind = t(IDENTIFIER_KIND_LABELS[identifier.kind]);
            return (
              <DetailsItem
                key={key}
                label={
                  identifier.scheme === null
                    ? kind
                    : t("eInvoice.identifierWithScheme", {
                        kind,
                        scheme: identifier.scheme,
                      })
                }
              >
                <BidiText as="span" className="wrap-break-word">
                  {identifier.value}
                </BidiText>
              </DetailsItem>
            );
          })}
        </DetailsGrid>
      )}
      {party.address.length > 0 && (
        <address className="text-muted-foreground text-sm not-italic">
          {keyed(party.address).map(({ item: line, key }) => (
            <BidiText as="p" className="wrap-break-word" key={key}>
              {line}
            </BidiText>
          ))}
        </address>
      )}
    </Section>
  );
};

const LineItems = ({ invoice }: { invoice: EInvoice }) => {
  const t = useTranslations();
  const { currency, lineCount, lines } = invoice;
  if (lines.length === 0) {
    return null;
  }
  return (
    <Section title={t("eInvoice.lineItems")}>
      <Table density="compact">
        <TableHeader>
          <TableRow>
            <TableHead>{t("eInvoice.lineId")}</TableHead>
            <TableHead>{t("common.description")}</TableHead>
            <TableHead numeric>{t("eInvoice.quantity")}</TableHead>
            <TableHead numeric>{t("eInvoice.unitPrice")}</TableHead>
            <TableHead numeric>{t("eInvoice.vat")}</TableHead>
            <TableHead numeric>{t("eInvoice.netAmount")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keyed(lines).map(({ item: line, key }) => (
            <TableRow key={key}>
              <TableCell>{line.id !== null && <bdi>{line.id}</bdi>}</TableCell>
              <TableCell className="min-w-40 wrap-break-word whitespace-normal">
                {line.description !== null && (
                  <BidiText as="span">{line.description}</BidiText>
                )}
              </TableCell>
              <TableCell numeric>
                {line.quantity !== null && (
                  <bdi>
                    {line.unitCode === null
                      ? line.quantity
                      : `${line.quantity} ${line.unitCode}`}
                  </bdi>
                )}
              </TableCell>
              <TableCell numeric>
                {line.unitPrice !== null && (
                  <Amount amount={line.unitPrice} currency={currency} />
                )}
                {/* The price is for this quantity, when the file states it. */}
                {line.unitPrice !== null && line.priceBasis !== null && (
                  <PricedPer basis={line.priceBasis} />
                )}
              </TableCell>
              <TableCell numeric>
                <Rate category={line.vatCategory} rate={line.vatRate} />
              </TableCell>
              <TableCell numeric>
                {line.netAmount !== null && (
                  <Amount amount={line.netAmount} currency={currency} />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {lineCount > lines.length && (
        <p className="text-muted-foreground text-sm">
          {t("eInvoice.linesShown", {
            count: lineCount,
            shown: lines.length,
          })}
        </p>
      )}
    </Section>
  );
};

const VatBreakdown = ({ invoice }: { invoice: EInvoice }) => {
  const t = useTranslations();
  const { currency, vatBreakdown } = invoice;
  if (vatBreakdown.length === 0) {
    return null;
  }
  const hasExemption = vatBreakdown.some(
    ({ exemptionReason }) => exemptionReason !== null,
  );
  return (
    <Section title={t("eInvoice.vatBreakdown")}>
      <Table density="compact">
        <TableHeader>
          <TableRow>
            <TableHead>{t("eInvoice.vat")}</TableHead>
            <TableHead numeric>{t("eInvoice.taxableAmount")}</TableHead>
            <TableHead numeric>{t("eInvoice.taxAmount")}</TableHead>
            {hasExemption && (
              <TableHead>{t("eInvoice.exemptionReason")}</TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {keyed(vatBreakdown).map(({ item: row, key }) => (
            <TableRow key={key}>
              <TableCell>
                <Rate category={row.category} rate={row.rate} />
              </TableCell>
              <TableCell numeric>
                {row.taxableAmount !== null && (
                  <Amount amount={row.taxableAmount} currency={currency} />
                )}
              </TableCell>
              <TableCell numeric>
                {row.taxAmount !== null && (
                  <Amount amount={row.taxAmount} currency={currency} />
                )}
              </TableCell>
              {hasExemption && (
                <TableCell className="min-w-40 wrap-break-word whitespace-normal">
                  {row.exemptionReason !== null && (
                    <BidiText as="span">{row.exemptionReason}</BidiText>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
};

const TOTAL_LABELS = {
  netAmount: "eInvoice.netTotal",
  taxAmount: "eInvoice.taxTotal",
  grossAmount: "eInvoice.grossTotal",
  prepaidAmount: "eInvoice.prepaidAmount",
  payableAmount: "eInvoice.payableAmount",
} as const satisfies Record<keyof EInvoice["totals"], TranslationKey>;

const TOTAL_ORDER = [
  "netAmount",
  "taxAmount",
  "grossAmount",
  "prepaidAmount",
  "payableAmount",
] as const satisfies readonly (keyof EInvoice["totals"])[];

const Totals = ({ invoice }: { invoice: EInvoice }) => {
  const t = useTranslations();
  const stated = TOTAL_ORDER.flatMap((total) => {
    const amount = invoice.totals[total];
    return amount === null ? [] : [{ amount, total }];
  });
  if (stated.length === 0) {
    return null;
  }
  return (
    <Section title={t("eInvoice.totals")}>
      <DetailsGrid variant="list">
        {stated.map(({ amount, total }) => (
          <DetailsItem key={total} label={t(TOTAL_LABELS[total])}>
            <Amount amount={amount} currency={invoice.currency} />
          </DetailsItem>
        ))}
      </DetailsGrid>
    </Section>
  );
};

const Payments = ({ invoice }: { invoice: EInvoice }) => {
  const t = useTranslations();
  const payments = keyed(invoice.payments)
    .map(({ item: payment, key }) => ({
      key,
      rows: [
        { label: t("eInvoice.paymentMeansCode"), value: payment.meansCode },
        { label: t("eInvoice.paymentDueDate"), value: payment.dueDate },
        {
          label: t("eInvoice.paymentAmount"),
          value: payment.amount,
          amount: true,
        },
        { label: t("common.anonymizationLabels.iban"), value: payment.iban },
        { label: t("eInvoice.bic"), value: payment.bic },
        {
          label: t("common.anonymizationLabels.bankAccountNumber"),
          value: payment.accountNumber,
        },
        { label: t("eInvoice.bankCode"), value: payment.bankCode },
        { label: t("eInvoice.paymentReference"), value: payment.reference },
      ].filter(
        (row): row is typeof row & { value: string } => row.value !== null,
      ),
    }))
    .filter(({ rows }) => rows.length > 0);
  if (payments.length === 0) {
    return null;
  }
  return (
    <Section title={t("eInvoice.paymentDetails")}>
      <div className="divide-y">
        {payments.map(({ key, rows }) => (
          <div className="py-2 first:pt-0" key={key}>
            <DetailsGrid variant="list">
              {rows.map(({ amount, label, value }) => (
                <DetailsItem key={label} label={label}>
                  {amount ? (
                    <Amount amount={value} currency={invoice.currency} />
                  ) : (
                    <bdi className="wrap-break-word">{value}</bdi>
                  )}
                </DetailsItem>
              ))}
            </DetailsGrid>
          </div>
        ))}
      </div>
    </Section>
  );
};

const InvoiceDetails = ({
  count,
  invoice,
  position,
}: {
  count: number;
  invoice: EInvoice;
  position: number;
}) => {
  const t = useTranslations();
  const documentType = DOCUMENT_TYPES[invoice.documentType];
  const facts = [
    { label: t("eInvoice.issueDate"), value: invoice.issueDate },
    { label: t("eInvoice.taxPointDate"), value: invoice.taxPointDate },
    { label: t("eInvoice.paymentDueDate"), value: invoice.dueDate },
    { label: t("common.currency"), value: invoice.currency },
  ].filter(
    (fact): fact is typeof fact & { value: string } => fact.value !== null,
  );

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        {count > 1 && (
          <p className="text-muted-foreground text-xs">
            {t("eInvoice.batchPosition", { count, position })}
          </p>
        )}
        <h2 className="text-base font-medium wrap-break-word">
          {invoice.number === null
            ? t(DOCUMENT_TYPE_LABELS[invoice.documentType])
            : t("eInvoice.documentTitleNumbered", {
                documentType,
                number: invoice.number,
              })}
        </h2>
      </header>
      {facts.length > 0 && (
        <DetailsGrid variant="list">
          {facts.map(({ label, value }) => (
            <DetailsItem key={label} label={label}>
              <bdi className="tabular-nums">{value}</bdi>
            </DetailsItem>
          ))}
        </DetailsGrid>
      )}
      <div className="grid gap-4 @md:grid-cols-2">
        <PartyDetails party={invoice.seller} title={t("eInvoice.supplier")} />
        <PartyDetails party={invoice.buyer} title={t("eInvoice.customer")} />
      </div>
      <LineItems invoice={invoice} />
      <VatBreakdown invoice={invoice} />
      <Totals invoice={invoice} />
      <Payments invoice={invoice} />
      {invoice.notes.length > 0 && (
        <Section title={t("common.notes")}>
          {keyed(invoice.notes).map(({ item: note, key }) => (
            <BidiText
              as="p"
              className="text-sm wrap-break-word whitespace-pre-wrap"
              key={key}
            >
              {note}
            </BidiText>
          ))}
        </Section>
      )}
    </section>
  );
};

/**
 * A structured invoice as its file states it: every value verbatim, nothing
 * recomputed. Its attachments are parts of the stored file (the invoice, or
 * the signed envelope around it), listed and opened like any other part.
 */
export const EInvoiceDetails = ({
  actions,
  onOpenAttachment,
  preview,
}: {
  actions: FilePartActions;
  onOpenAttachment: (part: string) => void;
  preview: EInvoicePreview;
}) => {
  const t = useTranslations();
  const format = SYNTAX_LABELS[preview.syntax];
  return (
    <div className="@container space-y-6">
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <DocumentMark
          aria-hidden="true"
          className="size-4 shrink-0"
          kind={SYNTAX_MARKS[preview.syntax]}
        />
        <bdi>
          {preview.version === null
            ? format
            : t("eInvoice.formatVersion", {
                format,
                version: preview.version,
              })}
        </bdi>
      </p>
      {keyed(preview.invoices, (invoice) => [
        invoice.documentType,
        invoice.number,
        invoice.issueDate,
      ]).map(({ item: invoice, key }, index) => (
        <InvoiceDetails
          count={preview.invoices.length}
          invoice={invoice}
          key={key}
          position={index + 1}
        />
      ))}
      <FilePartList
        actions={actions}
        onOpen={onOpenAttachment}
        parts={preview.attachments.map((attachment) => ({
          ...attachment,
          detail: attachment.description,
        }))}
        title={t("eInvoice.attachments")}
      />
    </div>
  );
};
