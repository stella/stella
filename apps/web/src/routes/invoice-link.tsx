import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";

import { InvoiceLinkPage } from "./-invoice-link.page";

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
