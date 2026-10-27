/**
 * The page an invoice email links to reads through these routes. They take
 * no session: the link's token in the request body is the credential, and
 * the per-address budget bounds how fast anyone can try one. There is no
 * member to enrol, so instead of the time-billing route gates each handler
 * admits the request only while the deployment offers the feature, and
 * answers a disabled deployment like a dead link.
 */
import downloadInvoiceLinkFile from "@/api/handlers/invoice-links/download";
import viewInvoiceLink from "@/api/handlers/invoice-links/view";
import { routes } from "@/api/http/route";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

const invoiceLinkBudget = rateLimit({
  duration: API_RATE_LIMITS.invoiceLink.duration,
  max: API_RATE_LIMITS.invoiceLink.max,
  budget: { name: "api.invoice_link.address", keyKind: "address" },
  ...createRedisRateLimit({
    failurePolicy: "fail_open_local",
    scope: "invoice-link",
  }),
});

export const invoiceLinksRoute = routes(
  {
    "/view": { POST: viewInvoiceLink },
    "/download": { POST: downloadInvoiceLinkFile },
  },
  {
    prefix: "/public/invoice-links",
    middleware: [invoiceLinkBudget],
  },
);
