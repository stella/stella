import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";

import { useMessageLocale } from "@/i18n/message-locale";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";

/** The formats the export endpoint accepts. */
type InvoiceExportFormat = Parameters<
  ReturnType<typeof api.invoices>["export"]["post"]
>[0]["format"];

// Product and standard names read the same in every language.
const PRODUCT_NAMES = {
  pohoda: "POHODA (XML)",
  money_s3: "Money S3 (XML)",
  flexibee: "ABRA Flexi (XML)",
  ledes_1998b: "LEDES 1998B",
  ubl: "UBL 2.1 (EN 16931)",
  peppol_sk: "Peppol (Slovakia)",
} as const;

type FormatLabel = TranslationKey | { name: string };

const FORMAT_GROUPS = [
  {
    labelKey: "billing.invoices.export.spreadsheets",
    formats: [
      ["xlsx", "billing.invoices.export.xlsx"],
      ["xlsx_lines", "billing.invoices.export.xlsxLines"],
      ["eso9", "billing.invoices.export.eso9"],
    ],
  },
  {
    labelKey: "billing.invoices.export.accounting",
    formats: [
      ["pohoda", { name: PRODUCT_NAMES.pohoda }],
      ["money_s3", { name: PRODUCT_NAMES.money_s3 }],
      ["flexibee", { name: PRODUCT_NAMES.flexibee }],
      ["isdoc", "billing.invoices.export.isdoc"],
    ],
  },
  {
    labelKey: "billing.invoices.export.eBilling",
    formats: [
      ["ubl", { name: PRODUCT_NAMES.ubl }],
      ["peppol_sk", { name: PRODUCT_NAMES.peppol_sk }],
      ["ksef_fa3", "billing.invoices.export.ksefFa3"],
      ["ledes_1998b", { name: PRODUCT_NAMES.ledes_1998b }],
    ],
  },
] as const satisfies readonly {
  labelKey: TranslationKey;
  formats: readonly (readonly [InvoiceExportFormat, FormatLabel])[];
}[];

// Every format the endpoint accepts has an entry in the menu.
true satisfies Exclude<
  InvoiceExportFormat,
  (typeof FORMAT_GROUPS)[number]["formats"][number][0]
> extends never
  ? true
  : never;

type InvoiceExportMenuProps = {
  workspaceId: string;
  /** Export just this invoice; omit to export every issued invoice. */
  invoiceId?: string;
};

/** Downloads issued invoices as a spreadsheet or an accounting import file. */
export const InvoiceExportMenu = ({
  workspaceId,
  invoiceId,
}: InvoiceExportMenuProps) => {
  const t = useTranslations();
  const messageLocale = useMessageLocale();
  const analytics = useAnalytics();
  const exportFile = useMutation({
    mutationFn: async (format: InvoiceExportFormat) => {
      const response = await api
        .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .export.post(
          {
            format,
            ...(invoiceId === undefined
              ? {}
              : { invoiceIds: [toSafeId<"invoice">(invoiceId)] }),
          },
          { headers: { "Accept-Language": messageLocale } },
        );
      // The presigned URL answers as an attachment under its file name.
      const { downloadUrl } = unwrapApiResponse(response);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    },
    onError: (error, format) => {
      analytics.captureError(error, {
        fingerprintKey: "InvoiceExportMenu:failure",
        scope: { type: "handler", handlerId: `invoice-export.${format}` },
      });
      notifyUserError(error, t("workspaces.views.exportFailed"));
    },
  });

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-busy={exportFile.isPending}
            disabled={exportFile.isPending}
            size="sm"
            variant="outline"
          />
        }
      >
        {exportFile.isPending ? (
          <Loader label={t("billing.invoices.export.exporting")} size="sm" />
        ) : (
          <DownloadIcon className="size-3.5" />
        )}
        {t("clauses.export")}
      </MenuTrigger>
      <MenuPopup className="min-w-64">
        {FORMAT_GROUPS.map((group, index) => (
          <MenuGroup key={group.labelKey}>
            {index > 0 && <MenuSeparator />}
            <MenuGroupLabel>{t(group.labelKey)}</MenuGroupLabel>
            {group.formats.map(([format, label]) => (
              <MenuItem
                disabled={exportFile.isPending}
                key={format}
                onClick={() => exportFile.mutate(format)}
              >
                {typeof label === "string" ? t(label) : label.name}
              </MenuItem>
            ))}
          </MenuGroup>
        ))}
      </MenuPopup>
    </Menu>
  );
};
