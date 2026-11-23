import { Result, TaggedError } from "better-result";
import { resolveTxt as nodeResolveTxt } from "node:dns/promises";

import {
  SSO_DOMAIN_TXT_HOST_PREFIX,
  SSO_DOMAIN_TXT_VALUE_PREFIX,
} from "@stll/api-contract/sso";

const DNS_VERIFY_TIMEOUT_MS = 5000;

export type TxtResolver = (hostname: string) => Promise<string[][]>;

export class SsoDomainDnsError extends TaggedError("sso_domain_dns_error")<{
  message: string;
  domain: string;
}> {}

export type DomainVerificationOutcome =
  | { status: "verified"; matchedHost: string }
  | { status: "not_found"; checkedHosts: readonly string[] };

/** Builds the DNS TXT host and value an administrator must publish. */
export const domainTxtInstruction = (
  domain: string,
  verificationToken: string,
) => ({
  txtHost: `${SSO_DOMAIN_TXT_HOST_PREFIX}${domain}`,
  txtValue: verificationToken.startsWith(SSO_DOMAIN_TXT_VALUE_PREFIX)
    ? verificationToken
    : `${SSO_DOMAIN_TXT_VALUE_PREFIX}${verificationToken}`,
});

const resolveTxtWithTimeout = async (
  resolveTxt: TxtResolver,
  host: string,
  timeoutMs: number,
): Promise<Result<string[][], SsoDomainDnsError>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Result.tryPromise({
    try: async () =>
      await Promise.race([
        resolveTxt(host),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new SsoDomainDnsError({
                message: `DNS TXT lookup timed out for ${host}`,
                domain: host,
              }),
            );
          }, timeoutMs);
        }),
      ]),
    catch: (error: unknown) => error,
  });
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (settled.isOk()) {
    return settled;
  }
  const error = settled.error;
  if (SsoDomainDnsError.is(error)) {
    return Result.err(error);
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") {
    return Result.ok([]);
  }
  return Result.err(
    new SsoDomainDnsError({
      message: `DNS TXT lookup failed for ${host}`,
      domain: host,
    }),
  );
};

type VerifyDomainTxtOptions = {
  domain: string;
  expectedToken: string;
  resolveTxt?: TxtResolver;
  timeoutMs?: number;
};

/**
 * Checks `_stella-verification.<domain>` and `<domain>` TXT records for the
 * organization's verification token. Returns a typed error only on transport
 * failure or timeout; missing records return `{ status: "not_found" }`.
 */
export const verifyDomainTxtRecord = async ({
  domain,
  expectedToken,
  resolveTxt = nodeResolveTxt,
  timeoutMs = DNS_VERIFY_TIMEOUT_MS,
}: VerifyDomainTxtOptions): Promise<
  Result<DomainVerificationOutcome, SsoDomainDnsError>
> => {
  const { txtHost, txtValue } = domainTxtInstruction(domain, expectedToken);
  const hosts = [txtHost, domain] as const;

  for (const host of hosts) {
    const lookup = await resolveTxtWithTimeout(resolveTxt, host, timeoutMs);
    if (lookup.isErr()) {
      return Result.err(lookup.error);
    }
    const matched = lookup.value.some(
      (chunks) => chunks.join("").trim() === txtValue,
    );
    if (matched) {
      return Result.ok({ status: "verified", matchedHost: host });
    }
  }

  return Result.ok({ status: "not_found", checkedHosts: hosts });
};
