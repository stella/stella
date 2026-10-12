import { useMutation } from "@tanstack/react-query";
import { useLocale, useTranslations } from "use-intl";

import { fetchWithTimeout } from "@stll/fetch";
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

import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { downloadFile } from "@/lib/utils";

const EXPORT_TIMEOUT_MS = 120_000;

type InvoiceExportFormat =
  | "xlsx"
  | "xlsx_lines"
  | "eso9"
  | "pohoda"
  | "money_s3"
  | "flexibee"
  | "isdoc"
  | "ubl"
  | "ledes_1998b";

// Product and standard names read the same in every language.
const PRODUCT_NAMES = {
  pohoda: "POHODA (XML)",
  money_s3: "Money S3 (XML)",
  flexibee: "ABRA Flexi (XML)",
  ledes_1998b: "LEDES 1998B",
  ubl: "UBL 2.1 (EN 16931)",
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
      ["ledes_1998b", { name: PRODUCT_NAMES.ledes_1998b }],
    ],
  },
] as const satisfies readonly {
  labelKey: TranslationKey;
  formats: readonly (readonly [InvoiceExportFormat, FormatLabel])[];
}[];

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
  const locale = useLocale();
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
          {
            headers: { "Accept-Language": locale },
            fetch: { signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) },
          },
        );
      const { downloadUrl, fileName } = unwrapEden(response);
      const file = await fetchWithTimeout(downloadUrl, {
        timeoutMs: EXPORT_TIMEOUT_MS,
      });
      if (!file.ok) {
        unwrapEden({
          data: null,
          error: {
            status: file.status,
            value: "Invoice export download failed",
          },
        });
      }
      downloadFile(await file.blob(), fileName);
    },
    onError: (error) => {
      analytics.captureError(error);
      notifyUserError(error, t("billing.invoices.export.failed"));
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
        {t("billing.invoices.export.menu")}
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
