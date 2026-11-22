import type { ReactNode } from "react";

import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import type {
  E_INVOICE_DOCUMENT_TYPES,
  E_INVOICE_IDENTIFIER_KINDS,
  E_INVOICE_SYNTAXES,
  EInvoice,
  EInvoicePreview,
} from "@stll/api-contract/e-invoice";
import { FILE_PART_KINDS, filePartId } from "@stll/api-contract/file-parts";
import { formatFileSize } from "@stll/ui/file-size";
import { Text } from "@stll/ui/text";

import { OpenFilePart } from "@/components/file-part-opener";

type Syntax = (typeof E_INVOICE_SYNTAXES)[number];

/** Format names are proper names and stay as their specifications write them. */
const SYNTAX_LABELS = {
  cii: "CII",
  fatturaPA: "FatturaPA",
  isdoc: "ISDOC",
  ubl: "UBL",
} as const satisfies Record<Syntax, string>;

const IDENTIFIER_KIND_LABELS = {
  other: "otherIdentifier",
  registration: "registrationNumber",
  tax: "taxId",
  vat: "vatId",
} as const satisfies Record<
  (typeof E_INVOICE_IDENTIFIER_KINDS)[number],
  string
>;

// The select keys the document title's message branches on.
const DOCUMENT_TYPES = {
  advance: "advance",
  creditNote: "creditNote",
  debitNote: "debitNote",
  invoice: "invoice",
  other: "other",
} as const satisfies {
  [Type in (typeof E_INVOICE_DOCUMENT_TYPES)[number]]: Type;
};

const TOTAL_LABELS = [
  ["netAmount", "netTotal"],
  ["taxAmount", "taxTotal"],
  ["grossAmount", "grossTotal"],
  ["prepaidAmount", "prepaidAmount"],
  ["payableAmount", "payableAmount"],
] as const satisfies readonly (readonly [keyof EInvoice["totals"], string])[];

type Row = { readonly label: string; readonly value: string | null };

/**
 * What the file lists without ids (lines, notes, a batch's invoices) is keyed
 * by its content and the how-manieth time that content repeats.
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

/** Label and value pairs, leaving out what the file does not state. */
const Rows = ({ rows }: { rows: readonly Row[] }) => (
  <View className="gap-1">
    {keyed(rows).flatMap(({ item: { label, value }, key }) =>
      value === null
        ? []
        : [
            <View className="flex-row flex-wrap gap-x-2" key={key}>
              <Text variant="caption">{label}</Text>
              <Text className="shrink" selectable variant="label">
                {value}
              </Text>
            </View>,
          ],
    )}
  </View>
);

const Section = ({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) => (
  <View className="gap-2">
    <Text accessibilityRole="header" variant="section">
      {title}
    </Text>
    {children}
  </View>
);

const useAmounts = (currency: string | null) => {
  const t = useTranslations("eInvoice");
  const amount = (value: string | null) =>
    value === null || currency === null
      ? value
      : t("amountWithCurrency", { amount: value, currency });
  const rate = (value: string | null, category: string | null) => {
    if (value === null) {
      return category;
    }
    return category === null
      ? t("ratePercent", { rate: value })
      : t("ratePercentWithCategory", { category, rate: value });
  };
  return { amount, rate };
};

const PartyDetails = ({
  party,
  title,
}: {
  party: EInvoice["seller"];
  title: string;
}) => {
  const t = useTranslations("eInvoice");
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
        <Text selectable variant="rowTitle">
          {party.name}
        </Text>
      )}
      {party.identifiers.length > 0 && (
        <Rows
          rows={party.identifiers.map(({ kind, scheme, value }) => {
            const label = t(IDENTIFIER_KIND_LABELS[kind]);
            return {
              label:
                scheme === null
                  ? label
                  : t("identifierWithScheme", { kind: label, scheme }),
              value,
            };
          })}
        />
      )}
      {party.address.length > 0 && (
        <Text selectable variant="caption">
          {party.address.join("\n")}
        </Text>
      )}
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
  const t = useTranslations("eInvoice");
  const { amount, rate } = useAmounts(invoice.currency);
  const documentType = DOCUMENT_TYPES[invoice.documentType];
  const totals = TOTAL_LABELS.map(([total, label]) => ({
    label: t(label),
    value: amount(invoice.totals[total]),
  }));
  const payments = keyed(invoice.payments)
    .map(({ item: payment, key }) => ({
      key,
      rows: [
        { label: t("paymentMeansCode"), value: payment.meansCode },
        { label: t("paymentDueDate"), value: payment.dueDate },
        { label: t("paymentAmount"), value: amount(payment.amount) },
        { label: t("iban"), value: payment.iban },
        { label: t("bic"), value: payment.bic },
        { label: t("accountNumber"), value: payment.accountNumber },
        { label: t("bankCode"), value: payment.bankCode },
        { label: t("paymentReference"), value: payment.reference },
      ],
    }))
    .filter(({ rows }) => rows.some(({ value }) => value !== null));

  return (
    <View className="gap-4">
      <View className="gap-1">
        {count > 1 && (
          <Text variant="caption">
            {t("batchPosition", { count, position })}
          </Text>
        )}
        <Text accessibilityRole="header" selectable variant="headline">
          {invoice.number === null
            ? t("documentTitle", { documentType })
            : t("documentTitleNumbered", {
                documentType,
                number: invoice.number,
              })}
        </Text>
      </View>
      <Rows
        rows={[
          { label: t("issueDate"), value: invoice.issueDate },
          { label: t("taxPointDate"), value: invoice.taxPointDate },
          { label: t("paymentDueDate"), value: invoice.dueDate },
          { label: t("currency"), value: invoice.currency },
        ]}
      />
      <PartyDetails party={invoice.seller} title={t("supplier")} />
      <PartyDetails party={invoice.buyer} title={t("customer")} />
      {invoice.lines.length > 0 && (
        <Section title={t("lineItems")}>
          {keyed(invoice.lines).map(({ item: line, key }) => (
            <View className="border-border gap-1 border-b pb-2" key={key}>
              {line.description !== null && (
                <Text selectable>{line.description}</Text>
              )}
              <Rows
                rows={[
                  { label: t("lineId"), value: line.id },
                  {
                    label: t("quantity"),
                    value:
                      line.quantity === null || line.unitCode === null
                        ? line.quantity
                        : `${line.quantity} ${line.unitCode}`,
                  },
                  {
                    label: t("unitPrice"),
                    // The price is for this quantity, when the file states it.
                    value:
                      line.unitPrice === null || line.priceBasis === null
                        ? amount(line.unitPrice)
                        : `${amount(line.unitPrice) ?? ""} / ${line.priceBasis}`,
                  },
                  {
                    label: t("vat"),
                    value: rate(line.vatRate, line.vatCategory),
                  },
                  { label: t("netAmount"), value: amount(line.netAmount) },
                ]}
              />
            </View>
          ))}
          {invoice.lineCount > invoice.lines.length && (
            <Text variant="caption">
              {t("linesShown", {
                count: invoice.lineCount,
                shown: invoice.lines.length,
              })}
            </Text>
          )}
        </Section>
      )}
      {invoice.vatBreakdown.length > 0 && (
        <Section title={t("vatBreakdown")}>
          {keyed(invoice.vatBreakdown).map(({ item: row, key }) => (
            <Rows
              key={key}
              rows={[
                { label: t("vat"), value: rate(row.rate, row.category) },
                { label: t("taxableAmount"), value: amount(row.taxableAmount) },
                { label: t("taxAmount"), value: amount(row.taxAmount) },
                { label: t("exemptionReason"), value: row.exemptionReason },
              ]}
            />
          ))}
        </Section>
      )}
      {totals.some(({ value }) => value !== null) && (
        <Section title={t("totals")}>
          <Rows rows={totals} />
        </Section>
      )}
      {payments.length > 0 && (
        <Section title={t("paymentDetails")}>
          {payments.map(({ key, rows }) => (
            <Rows key={key} rows={rows} />
          ))}
        </Section>
      )}
      {invoice.notes.length > 0 && (
        <Section title={t("notes")}>
          {keyed(invoice.notes).map(({ item: note, key }) => (
            <Text key={key} selectable>
              {note}
            </Text>
          ))}
        </Section>
      )}
    </View>
  );
};

/**
 * A structured invoice as its file states it: every value verbatim, nothing
 * recomputed. Each attachment opens like a document where the phone can.
 */
export const EInvoiceDetails = ({ preview }: { preview: EInvoicePreview }) => {
  const t = useTranslations("eInvoice");
  const format = useFormatter();
  const syntax = SYNTAX_LABELS[preview.syntax];
  return (
    <View className="gap-6">
      <Text variant="caption">
        {preview.version === null
          ? syntax
          : t("formatVersion", { format: syntax, version: preview.version })}
      </Text>
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
      {preview.attachments.length > 0 && (
        <Section title={t("attachments")}>
          {preview.attachments.map((attachment) => (
            <View className="gap-0.5" key={attachment.index}>
              <Text selectable variant="label">
                {attachment.fileName}
              </Text>
              {attachment.description !== null && (
                <Text selectable variant="caption">
                  {attachment.description}
                </Text>
              )}
              <Text variant="caption">
                {formatFileSize(attachment.sizeBytes, format)}
              </Text>
              <OpenFilePart
                fileName={attachment.fileName}
                part={filePartId({
                  kind: FILE_PART_KINDS.attachment,
                  index: attachment.index,
                })}
              />
            </View>
          ))}
        </Section>
      )}
    </View>
  );
};
