import { APIError } from "@/lib/errors/api";

export type InvoiceLinkFile = "pdf" | "e_invoice";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

/** The link's token from the URL fragment, or null when it is not one. */
export const invoiceLinkTokenFromHash = (hash: string): string | null => {
  const token = hash.startsWith("#") ? hash.slice(1) : hash;
  return TOKEN_PATTERN.test(token) ? token : null;
};

/**
 * Why the invoice did not open. The API answers every dead link the same
 * way, so the page cannot tell an expired link from a revoked one either.
 */
export const invoiceLinkFailure = (
  error: unknown,
): "unavailable" | "busy" | "error" => {
  if (!(error instanceof APIError)) {
    return "error";
  }
  if (error.status === 404) {
    return "unavailable";
  }
  return error.status === 429 ? "busy" : "error";
};

/** The payment QR as an image source; an image cannot run script. */
export const qrImageSource = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
