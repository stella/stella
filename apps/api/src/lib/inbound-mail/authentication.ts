import { Result, TaggedError } from "better-result";
import { authenticate, type DNSResolver } from "mailauth";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { getDomain } from "tldts";

import { INBOUND_MAIL_LIMITS } from "@/api/lib/inbound-mail/limits";

export type MailEnvelope = {
  mailFrom: string;
  recipients: string[];
  remoteIp: string;
  helo: string;
};

const AUTH_RESULTS = [
  "pass",
  "fail",
  "none",
  "neutral",
  "softfail",
  "temperror",
  "permerror",
] as const;
export type MailAuthResult = (typeof AUTH_RESULTS)[number];

export type MailAuthentication = (
  | {
      source: "provider";
      evidence: "provider-dmarc";
    }
  | {
      source: "provider" | "local";
      evidence: "identifiers";
    }
) & {
  fromDomain: string;
  spf: {
    result: MailAuthResult;
    domain: string | null;
    alignment: "strict" | "relaxed";
  };
  dkim: {
    result: MailAuthResult;
    domain: string | null;
    alignment: "strict" | "relaxed";
  }[];
  dmarc: MailAuthResult;
};

export class MailAuthenticationError extends TaggedError(
  "MailAuthenticationError",
)<{
  message: string;
}> {}

type VerifyMailOptions = {
  raw: Uint8Array;
  envelope: MailEnvelope;
  fromAddress: string;
};

export type MailVerifier = (
  options: VerifyMailOptions,
) => Promise<Result<MailAuthentication, MailAuthenticationError>>;

const normalizeDomain = (input: string) => {
  const domain = input.toLowerCase();
  if (
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/u.test(
      domain,
    )
  ) {
    return null;
  }
  return domain;
};

export const mailboxDomain = (address: string) => {
  const at = address.lastIndexOf("@");
  return at > 0 ? normalizeDomain(address.slice(at + 1)) : null;
};

type DomainAlignmentOptions = {
  fromDomain: string;
  authenticatedDomain: string | null;
  mode: "strict" | "relaxed";
};

export const domainsAlign = ({
  fromDomain,
  authenticatedDomain,
  mode,
}: DomainAlignmentOptions) => {
  const from = normalizeDomain(fromDomain);
  const authenticated =
    authenticatedDomain && normalizeDomain(authenticatedDomain);
  if (!from || !authenticated) {
    return false;
  }
  if (from === authenticated) {
    return true;
  }
  if (mode === "strict") {
    return false;
  }
  const organization = getDomain(from, { allowPrivateDomains: true });
  return (
    organization !== null &&
    organization === getDomain(authenticated, { allowPrivateDomains: true })
  );
};

export const hasAlignedAuthentication = (
  auth: MailAuthentication,
  fromAddress: string,
) => {
  const fromDomain = mailboxDomain(fromAddress);
  if (!fromDomain || auth.dmarc !== "pass" || fromDomain !== auth.fromDomain) {
    return false;
  }
  if (auth.evidence === "provider-dmarc") {
    return (
      auth.spf.result === "pass" ||
      auth.dkim.some(({ result }) => result === "pass")
    );
  }
  return (
    (auth.spf.result === "pass" &&
      domainsAlign({
        fromDomain,
        authenticatedDomain: auth.spf.domain,
        mode: auth.spf.alignment,
      })) ||
    auth.dkim.some(
      (signature) =>
        signature.result === "pass" &&
        domainsAlign({
          fromDomain,
          authenticatedDomain: signature.domain,
          mode: signature.alignment,
        }),
    )
  );
};

const authResult = (value: string): MailAuthResult => {
  for (const candidate of AUTH_RESULTS) {
    if (candidate === value) {
      return candidate;
    }
  }
  return "permerror";
};

// This parser only accepts a header value supplied out of band by the trusted
// receiving adapter. An authserv-id in the sender's RFC 822 bytes proves nothing.
const splitAuthResults = (value: string) => {
  if (
    value.length > INBOUND_MAIL_LIMITS.headerBytes ||
    /[\r\n\0]/u.test(value)
  ) {
    return null;
  }
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      if (depth === 0) {
        current += character;
      }
      escaped = false;
      continue;
    }
    if (character === "\\" && (quoted || depth > 0)) {
      escaped = true;
      continue;
    }
    if (!quoted && character === "(") {
      depth += 1;
      continue;
    }
    if (depth > 0) {
      if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          current += " ";
        }
      }
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (!quoted && character === ";") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    if (character === ")" && !quoted) {
      return null;
    }
    current += character;
  }
  if (quoted || depth !== 0 || escaped) {
    return null;
  }
  parts.push(current.trim());
  return parts;
};

type ProviderAuthOptions = {
  authenticationResults: string;
  authservId: string;
  fromAddress: string;
};

export const parseProviderAuthentication = ({
  authenticationResults,
  authservId,
  fromAddress,
}: ProviderAuthOptions) => {
  const parts = splitAuthResults(authenticationResults);
  const fromDomain = mailboxDomain(fromAddress);
  if (!parts || parts.shift() !== authservId || !fromDomain) {
    return Result.err(
      new MailAuthenticationError({
        message: "Invalid provider authentication metadata",
      }),
    );
  }
  const auth: MailAuthentication = {
    source: "provider",
    evidence: "identifiers",
    fromDomain,
    spf: { result: "none", domain: null, alignment: "relaxed" },
    dkim: [],
    dmarc: "none",
  };
  const seen = new Set<string>();
  for (const part of parts) {
    const match = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)(?:\s|$)/iu.exec(part);
    if (!match) {
      continue;
    }
    const method = match[1]?.toLowerCase();
    const result = authResult(match[2]?.toLowerCase() ?? "permerror");
    if (!method || (method !== "dkim" && seen.has(method))) {
      return Result.err(
        new MailAuthenticationError({
          message: "Ambiguous provider authentication metadata",
        }),
      );
    }
    seen.add(method);
    const properties = new Map<string, string>();
    for (const property of part
      .slice(match[0].length)
      .matchAll(/([a-z]+\.[a-z]+)\s*=\s*(?:"([^"\s]*)"|([^\s]+))/giu)) {
      const key = property[1]?.toLowerCase();
      const value = property[2] ?? property[3];
      if (!key || value === undefined || properties.has(key)) {
        return Result.err(
          new MailAuthenticationError({
            message: "Ambiguous provider authentication metadata",
          }),
        );
      }
      properties.set(key, value);
    }
    switch (method) {
      case "spf": {
        const mailFrom = properties.get("smtp.mailfrom");
        auth.spf = {
          result,
          domain: mailFrom
            ? (mailboxDomain(mailFrom) ?? normalizeDomain(mailFrom))
            : null,
          alignment: "relaxed",
        };
        break;
      }
      case "dkim": {
        const domain = properties.get("header.d");
        const identity = properties.get("header.i");
        const signingDomain =
          domain ?? identity?.slice(identity.lastIndexOf("@") + 1);
        auth.dkim.push({
          result,
          domain: signingDomain ? normalizeDomain(signingDomain) : null,
          alignment: "relaxed",
        });
        break;
      }
      case "dmarc":
        auth.dmarc =
          properties.get("header.from")?.toLowerCase() === fromDomain
            ? result
            : "permerror";
        break;
    }
  }
  return Result.ok(auth);
};

export const createProviderMailVerifier =
  (metadata: Omit<ProviderAuthOptions, "fromAddress">): MailVerifier =>
  async ({ fromAddress }) =>
    parseProviderAuthentication({ ...metadata, fromAddress });

type LocalDnsResolver = { resolve: DNSResolver; cancel: () => void };

export const createLocalMailVerifier =
  (
    createResolver: () => LocalDnsResolver = () => {
      const resolver = new Resolver({
        timeout: INBOUND_MAIL_LIMITS.dnsTimeoutMs,
        tries: 1,
      });
      return {
        resolve: async (domain, rrtype) =>
          await resolver.resolve(domain, rrtype),
        cancel: () => resolver.cancel(),
      };
    },
  ): MailVerifier =>
  async ({ raw, envelope, fromAddress }) => {
    const fromDomain = mailboxDomain(fromAddress);
    if (
      !fromDomain ||
      !isIP(envelope.remoteIp) ||
      !normalizeDomain(envelope.helo) ||
      raw.byteLength > INBOUND_MAIL_LIMITS.rawBytes
    ) {
      return Result.err(
        new MailAuthenticationError({
          message: "Invalid mail verification input",
        }),
      );
    }
    const resolver = createResolver();
    const signal = AbortSignal.timeout(
      INBOUND_MAIL_LIMITS.authenticationTimeoutMs,
    );
    let queries = 0;
    const cancellation = () => resolver.cancel();
    signal.addEventListener("abort", cancellation, { once: true });
    const verification = await Result.tryPromise({
      try: () =>
        authenticate(Buffer.from(raw), {
          sender: envelope.mailFrom,
          ip: envelope.remoteIp,
          helo: envelope.helo,
          trustReceived: false,
          disableArc: true,
          disableBimi: true,
          resolver: async (domain, rrtype) => {
            queries += 1;
            if (signal.aborted || queries > INBOUND_MAIL_LIMITS.dnsQueries) {
              throw new MailAuthenticationError({
                message: "Mail verification budget exhausted",
              });
            }
            return await resolver.resolve(domain, rrtype);
          },
        }),
      catch: () =>
        new MailAuthenticationError({
          message: "Mail authentication could not complete",
        }),
    });
    signal.removeEventListener("abort", cancellation);
    resolver.cancel();
    if (verification.isErr()) {
      return verification;
    }
    if (signal.aborted || queries > INBOUND_MAIL_LIMITS.dnsQueries) {
      return Result.err(
        new MailAuthenticationError({
          message: "Mail verification budget exhausted",
        }),
      );
    }
    const { spf, dkim, dmarc } = verification.value;
    return Result.ok({
      source: "local",
      evidence: "identifiers",
      fromDomain,
      spf: {
        result: spf ? authResult(spf.status.result) : "none",
        domain: spf ? spf.domain : null,
        alignment: dmarc && dmarc.alignment.spf.strict ? "strict" : "relaxed",
      },
      dkim: dkim.results.map((signature) => ({
        result: signature.status.underSized
          ? "fail"
          : authResult(signature.status.result),
        domain: signature.signingDomain,
        alignment: dmarc && dmarc.alignment.dkim.strict ? "strict" : "relaxed",
      })),
      dmarc: dmarc ? authResult(dmarc.status.result) : "none",
    } satisfies MailAuthentication);
  };

export const verifyMailLocally = createLocalMailVerifier();
