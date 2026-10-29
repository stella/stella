import { useMutation, useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { DownloadIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";
import { invoiceLinkDownload, invoiceLinkView } from "@/lib/api";
import { APIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { pageTitle } from "@/lib/page-title";
import { downloadFile } from "@/lib/utils";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";

import {
  invoiceLinkFailure,
  invoiceLinkTokenFromHash,
  qrImageSource,
} from "./-invoice-link.logic";
import type { InvoiceLinkFile } from "./-invoice-link.logic";

/**
 * The page an invoice email links to. The link's token rides in the URL
 * fragment, which the browser never sends to a server; the page posts it to
 * the API, which answers with the invoice summary and serves its files.
 */
export const Route = createFileRoute("/invoice-link")({
  ssr: false,
  staticData: { appFrame: APP_FRAME_SCOPE.none },
  head: () => ({
    meta: [
      { title: pageTitle("billing.numberSeries.invoice") },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: InvoiceLinkPage,
});

const viewInvoice = invoiceLinkView.open;

type InvoiceLinkView = Awaited<ReturnType<typeof viewInvoice>>;

const downloadInvoiceFile = async (
  token: string,
  file: InvoiceLinkFile,
  fileName: string,
) => {
  const downloaded = await Result.tryPromise({
    try: async () => {
      downloadFile(await invoiceLinkDownload.open({ token, file }), fileName);
      return Result.ok(undefined);
    },
    catch: (cause) =>
      new APIError({
        status: 0,
        message: "Invoice file download failed",
        cause,
      }),
  });
  return downloaded.isErr() ? Result.err(downloaded.error) : downloaded.value;
};

function InvoiceLinkPage() {
  const token = useLocation({
    select: (location) => invoiceLinkTokenFromHash(location.hash),
  });
  const invoice = useQuery({
    queryKey: ["invoice-link", token],
    enabled: token !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => (token === null ? null : await viewInvoice(token)),
  });

  return (
    <div className="flex min-h-full flex-1 justify-center px-4 py-10">
      <div className="w-full max-w-xl">
        <InvoiceLinkBody invoice={invoice} token={token} />
      </div>
    </div>
  );
}

const InvoiceLinkBody = ({
  token,
  invoice,
}: {
  token: string | null;
  invoice: UseQueryResult<InvoiceLinkView | null>;
}) => {
  if (token === null) {
    return <InvoiceLinkUnavailable reason="unavailable" />;
  }
  if (invoice.isPending) {
    return <InvoiceLinkSkeleton />;
  }
  if (invoice.isError) {
    return (
      <InvoiceLinkUnavailable reason={invoiceLinkFailure(invoice.error)} />
    );
  }
  if (invoice.data === null) {
    return <InvoiceLinkUnavailable reason="unavailable" />;
  }
  return <InvoiceSummary invoice={invoice.data} token={token} />;
};

const InvoiceLinkSkeleton = () => (
  <Frame>
    <FrameHeader>
      <Skeleton className="h-6 w-48" />
      <Skeleton className="mt-2 h-4 w-32" />
    </FrameHeader>
    <FramePanel className="flex flex-col gap-3">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-9 w-40" />
    </FramePanel>
  </Frame>
);

const InvoiceLinkUnavailable = ({
  reason,
}: {
  reason: ReturnType<typeof invoiceLinkFailure>;
}) => {
  const t = useTranslations("invoiceLink");
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>{t(`failure.${reason}.title`)}</FrameTitle>
        <FrameDescription>{t(`failure.${reason}.body`)}</FrameDescription>
      </FrameHeader>
    </Frame>
  );
};

export const InvoiceSummary = ({
  invoice,
  token,
}: {
  invoice: InvoiceLinkView;
  token: string;
}) => {
  const t = useTranslations("invoiceLink");
  const rootT = useTranslations();
  const format = useFormatter();
  const download = useMutation({
    mutationFn: async ({
      file,
      fileName,
    }: {
      file: InvoiceLinkFile;
      fileName: string;
    }) => await downloadInvoiceFile(token, file, fileName),
    onSuccess: (result) => {
      if (result.isErr()) {
        notifyUserError(result.error, t("downloadFailed"));
      }
    },
    onError: (error) => notifyUserError(error, t("downloadFailed")),
  });
  const { eInvoice } = invoice.files;

  return (
    <Frame>
      <FrameHeader>
        <div dir={invoice.dir} lang={invoice.language}>
          <FrameTitle>{invoice.title}</FrameTitle>
          {invoice.seller === null ? null : (
            <FrameDescription>{invoice.seller}</FrameDescription>
          )}
        </div>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-5">
        <div
          className="flex flex-col gap-4"
          dir={invoice.dir}
          lang={invoice.language}
        >
          {invoice.buyer === null ? null : (
            <p className="text-sm">{invoice.buyer}</p>
          )}
          <DetailsGrid>
            {invoice.meta.map((field) => (
              <DetailsItem key={field.label} label={field.label}>
                <span className="tabular-nums">{field.value}</span>
              </DetailsItem>
            ))}
            {invoice.totals.map((field, index) => {
              const isAmountDue = index === invoice.totals.length - 1;
              return (
                <DetailsItem
                  key={field.label}
                  label={
                    isAmountDue ? (
                      <span className="font-semibold">{field.label}</span>
                    ) : (
                      field.label
                    )
                  }
                >
                  <span
                    className={cn(
                      "tabular-nums",
                      isAmountDue && "font-semibold",
                    )}
                  >
                    {field.value}
                  </span>
                </DetailsItem>
              );
            })}
          </DetailsGrid>
          {invoice.paid ? (
            <p className="text-sm font-medium">{t("paid")}</p>
          ) : null}
          {invoice.payment === null ? null : (
            <section className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">{invoice.payment.label}</h2>
                <DetailsGrid>
                  {invoice.payment.fields.map((field) => (
                    <DetailsItem key={field.label} label={field.label}>
                      <span className="tabular-nums" dir="ltr">
                        {field.value}
                      </span>
                    </DetailsItem>
                  ))}
                </DetailsGrid>
                {invoice.payment.accountNumber === null ? null : (
                  <p className="text-sm tabular-nums" dir="ltr">
                    {invoice.payment.accountNumber}
                  </p>
                )}
              </div>
              {invoice.payment.qrSvg === null ? null : (
                <img
                  alt={t("paymentQr")}
                  className="size-36 shrink-0"
                  src={qrImageSource(invoice.payment.qrSvg)}
                />
              )}
            </section>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            loading={download.isPending && download.variables.file === "pdf"}
            onClick={() =>
              download.mutate({
                file: "pdf",
                fileName: invoice.files.pdf.fileName,
              })
            }
          >
            <DownloadIcon className="size-4" />
            {rootT("templates.downloadPdf")}
          </Button>
          {eInvoice === null ? null : (
            <Button
              loading={
                download.isPending && download.variables.file === "e_invoice"
              }
              onClick={() =>
                download.mutate({
                  file: "e_invoice",
                  fileName: eInvoice.fileName,
                })
              }
              variant="outline"
            >
              <DownloadIcon className="size-4" />
              {t(`downloadEInvoice.${eInvoice.format}`)}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          {t("validUntil", {
            date: format.dateTime(
              Temporal.Instant.from(invoice.expiresAt).epochMilliseconds,
              { dateStyle: "long" },
            ),
          })}
        </p>
      </FramePanel>
    </Frame>
  );
};
