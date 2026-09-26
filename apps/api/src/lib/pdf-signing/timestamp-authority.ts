/**
 * Trusted time from the first configured authority that answers.
 *
 * LibPDF asks a single `TimestampAuthority` for one token per signature. The
 * authority built here walks the configured list in order and hands back
 * the first token it gets, remembering which authority issued it so the
 * stored version can say whose time it carries.
 */

import { HttpTimestampAuthority } from "@libpdf/core";
import type { DigestAlgorithm, TimestampAuthority } from "@libpdf/core";
import { TaggedError } from "better-result";

import { env } from "@/api/env";
import { parseTimestampAuthorityUrls } from "@/api/lib/pdf-signing/timestamp-authority-urls";

/** Per authority; a slow one must leave time for the next. */
const TIMESTAMP_REQUEST_TIMEOUT_MS = 8000;

export type NamedTimestampAuthority = {
  authority: TimestampAuthority;
  url: string;
};

export class PdfSigningTimestampUnavailableError extends TaggedError(
  "PdfSigningTimestampUnavailableError",
)<{ message: string; failures: { url: string; message: string }[] }> {}

export type FallbackTimestampAuthority = TimestampAuthority & {
  /** The authority whose token was used, once one has answered. */
  usedUrl: () => string | null;
};

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const createFallbackTimestampAuthority = (
  authorities: readonly NamedTimestampAuthority[],
): FallbackTimestampAuthority => {
  let usedUrl: string | null = null;
  return {
    usedUrl: () => usedUrl,
    timestamp: async (digest: Uint8Array, algorithm: DigestAlgorithm) => {
      const failures: { url: string; message: string }[] = [];
      for (const { authority, url } of authorities) {
        try {
          // Sequential on purpose: the list is a preference order, and a
          // later authority is only asked once every earlier one failed.
          const token = await authority.timestamp(digest, algorithm);
          usedUrl = url;
          return token;
        } catch (error) {
          failures.push({ url, message: describe(error) });
        }
      }
      throw new PdfSigningTimestampUnavailableError({
        message: "No timestamp authority issued a timestamp.",
        failures,
      });
    },
  };
};

/** The configured authorities, in the order they are tried. */
export const configuredTimestampAuthorities = (): NamedTimestampAuthority[] =>
  parseTimestampAuthorityUrls({
    list: env.PDF_SIGNING_TSA_URLS,
    single: env.PDF_SIGNING_TSA_URL,
  }).map((url) => ({
    authority: new HttpTimestampAuthority(url, {
      timeout: TIMESTAMP_REQUEST_TIMEOUT_MS,
    }),
    url,
  }));
