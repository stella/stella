/**
 * Trusted time from the first configured authority that answers with a
 * valid token.
 *
 * LibPDF asks a single `TimestampAuthority` for one token per signature. The
 * authority built here walks the configured list in order, checks each
 * token (see `timestamp-token.ts`) and hands back the first valid one,
 * remembering which authority issued it and what it carried so the stored
 * version can say whose time it is and validation data can cover it.
 *
 * Requests go through the same guarded fetcher as other PKI data: DNS
 * pinned, no redirects, bounded time and size. The authorities are the
 * operator's choice, but a misbehaving one still cannot redirect the API
 * elsewhere or stream an unbounded body into it.
 */

import type { DigestAlgorithm, TimestampAuthority } from "@libpdf/core";
import * as asn1js from "asn1js";
import { Result, TaggedError } from "better-result";
import * as pkijs from "pkijs";

import { env } from "@/api/env";
import { settleForLibpdf } from "@/api/lib/files/pdf-signing/libpdf-callbacks";
import { safePkiFetch } from "@/api/lib/files/pdf-signing/pki-fetch";
import type { PkiFetcher } from "@/api/lib/files/pdf-signing/pki-fetch";
import { parseTimestampAuthorityUrls } from "@/api/lib/files/pdf-signing/timestamp-authority-urls";
import {
  PdfSigningTimestampInvalidError,
  validateTimestampToken,
} from "@/api/lib/files/pdf-signing/timestamp-token";
import type { ValidatedTimestamp } from "@/api/lib/files/pdf-signing/timestamp-token";

/** A token with the authority's chain is a few kilobytes; this is ample. */
const TIMESTAMP_RESPONSE_MAX_BYTES = 64 * 1024;
const SHA256_OID = "2.16.840.1.101.3.4.2.1";
/** RFC 3161 PKIStatus granted and grantedWithMods. */
const GRANTED_STATUSES = new Set([0, 1]);
const NONCE_BYTES = 8;

export type NamedTimestampAuthority = {
  authority: TimestampAuthority;
  url: string;
};

export class PdfSigningTimestampUnavailableError extends TaggedError(
  "PdfSigningTimestampUnavailableError",
)<{ message: string; failures: { url: string; message: string }[] }> {}

export type UsedTimestamp = ValidatedTimestamp & {
  token: Uint8Array;
  url: string;
};

export type FallbackTimestampAuthority = TimestampAuthority & {
  /** The token that was used and what it carried, once one was valid. */
  used: () => UsedTimestamp | null;
  /** The token that was used, once an authority has answered. */
  usedToken: () => Uint8Array | null;
  /** The authority that issued it. */
  usedUrl: () => string | null;
};

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const sha256Only = (
  algorithm: DigestAlgorithm,
): Result<void, PdfSigningTimestampInvalidError> =>
  algorithm === "SHA-256"
    ? Result.ok(undefined)
    : Result.err(
        new PdfSigningTimestampInvalidError({
          message: `Timestamps are only requested over SHA-256, not ${algorithm}.`,
        }),
      );

export const createFallbackTimestampAuthority = (
  authorities: readonly NamedTimestampAuthority[],
  now: () => Date = () => new Date(),
): FallbackTimestampAuthority => {
  let used: UsedTimestamp | null = null;

  const firstValid = async (
    digest: Uint8Array,
    algorithm: DigestAlgorithm,
  ): Promise<
    Result<
      Uint8Array,
      PdfSigningTimestampInvalidError | PdfSigningTimestampUnavailableError
    >
  > => {
    const supported = sha256Only(algorithm);
    if (Result.isError(supported)) {
      return supported;
    }
    const failures: { url: string; message: string }[] = [];
    for (const { authority, url } of authorities) {
      // Sequential on purpose: the list is a preference order, and a later
      // authority is only asked once every earlier one failed.
      const token = await Result.tryPromise(
        async () => await authority.timestamp(digest, algorithm),
      );
      if (Result.isError(token)) {
        failures.push({ url, message: describe(token.error.cause) });
        continue;
      }
      const validated = await validateTimestampToken({
        digest,
        now: now(),
        token: token.value,
      });
      if (Result.isError(validated)) {
        failures.push({ url, message: describe(validated.error) });
        continue;
      }
      used = { ...validated.value, token: token.value, url };
      return Result.ok(token.value);
    }
    return Result.err(
      new PdfSigningTimestampUnavailableError({
        message: "No timestamp authority issued a valid timestamp.",
        failures,
      }),
    );
  };

  return {
    used: () => used,
    usedToken: () => used?.token ?? null,
    usedUrl: () => used?.url ?? null,
    timestamp: async (digest: Uint8Array, algorithm: DigestAlgorithm) =>
      await settleForLibpdf(firstValid(digest, algorithm)),
  };
};

const randomNonce = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  // A positive INTEGER: clear the sign bit rather than grow the encoding.
  bytes[0] = (bytes[0] ?? 0) % 0x80;
  return new asn1js.Integer({ valueHex: bytes.buffer });
};

/** One RFC 3161 request to `url`, and its token once it checks out. */
const requestTimestamp = async ({
  algorithm,
  digest,
  fetcher,
  now,
  url,
}: {
  algorithm: DigestAlgorithm;
  digest: Uint8Array;
  fetcher: PkiFetcher;
  now: () => Date;
  url: string;
}): Promise<Result<Uint8Array, PdfSigningTimestampInvalidError>> => {
  const supported = sha256Only(algorithm);
  if (Result.isError(supported)) {
    return supported;
  }
  const nonce = randomNonce();
  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: SHA256_OID,
      }),
      hashedMessage: new asn1js.OctetString({
        valueHex: new Uint8Array(digest).buffer,
      }),
    }),
    nonce,
    certReq: true,
  });
  const body = await fetcher({
    body: new Uint8Array(request.toSchema().toBER(false)),
    contentType: "application/timestamp-query",
    maxBytes: TIMESTAMP_RESPONSE_MAX_BYTES,
    method: "POST",
    url,
  });
  if (body === null) {
    return Result.err(
      new PdfSigningTimestampInvalidError({
        message: "The timestamp authority did not answer.",
      }),
    );
  }
  const response = Result.try(() =>
    pkijs.TimeStampResp.fromBER(new Uint8Array(body)),
  );
  if (Result.isError(response)) {
    return Result.err(unreadableAnswer());
  }
  const { status, timeStampToken } = response.value;
  if (!GRANTED_STATUSES.has(status.status) || timeStampToken === undefined) {
    return Result.err(
      new PdfSigningTimestampInvalidError({
        message: "The timestamp authority refused the request.",
      }),
    );
  }
  const token = Result.try(
    () => new Uint8Array(timeStampToken.toSchema().toBER(false)),
  );
  if (Result.isError(token)) {
    return Result.err(unreadableAnswer());
  }
  const validated = await validateTimestampToken({
    digest,
    nonce,
    now: now(),
    token: token.value,
  });
  return Result.isError(validated) ? validated : Result.ok(token.value);
};

const unreadableAnswer = () =>
  new PdfSigningTimestampInvalidError({
    message: "The timestamp authority's answer could not be read.",
  });

/**
 * An RFC 3161 client over the guarded fetcher. Its tokens must answer the
 * nonce it sent; the rest of the token is checked by the fallback above.
 */
export const createHttpTimestampAuthority = (
  url: string,
  fetcher: PkiFetcher = safePkiFetch,
  now: () => Date = () => new Date(),
): TimestampAuthority => ({
  timestamp: async (digest: Uint8Array, algorithm: DigestAlgorithm) =>
    await settleForLibpdf(
      requestTimestamp({ algorithm, digest, fetcher, now, url }),
    ),
});

/** The configured authorities, in the order they are tried. */
export const configuredTimestampAuthorities = (): NamedTimestampAuthority[] =>
  parseTimestampAuthorityUrls({
    list: env.PDF_SIGNING_TSA_URLS,
    single: env.PDF_SIGNING_TSA_URL,
  }).map((url) => ({ authority: createHttpTimestampAuthority(url), url }));
