import { panic, Result, TaggedError } from "better-result";
import { X509Certificate } from "node:crypto";

import { SAML_METADATA_MAX_BYTES } from "@stll/api-contract/sso";
import type {
  ParseSamlMetadataBody,
  ParseSamlMetadataResponse,
} from "@stll/api-contract/sso";
import { declareFingerprintFields } from "@stll/errors";

import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

const SAML_METADATA_TIMEOUT_MS = 8000;
const SAML_HTTP_REDIRECT_BINDING =
  "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";

export class SamlMetadataError extends TaggedError("saml_metadata_error")<{
  message: string;
  reason: "invalid_url" | "fetch_failed" | "invalid_document";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const decodeXmlEntities = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

const readAttribute = (tag: string, name: string): string | undefined => {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "u");
  const match = pattern.exec(tag);
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? undefined : decodeXmlEntities(raw).trim();
};

const formatPemCertificate = (rawBase64: string): string | undefined => {
  const cleaned = rawBase64
    .replace(/-----BEGIN CERTIFICATE-----/gu, "")
    .replace(/-----END CERTIFICATE-----/gu, "")
    .replace(/\s+/gu, "");
  if (cleaned.length < 64 || !/^[A-Za-z0-9+/=]+$/u.test(cleaned)) {
    return undefined;
  }
  const lines: string[] = [];
  for (let i = 0; i < cleaned.length; i += 64) {
    lines.push(cleaned.slice(i, i + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
};

const validateHttpsUrl = (
  raw: string,
  label: string,
): Result<string, SamlMetadataError> => {
  const parsed = Result.try({
    try: () => new URL(raw.trim()),
    catch: () =>
      new SamlMetadataError({
        message: `${label} is not a valid URL`,
        reason: "invalid_url",
      }),
  });
  if (parsed.isErr()) {
    return parsed;
  }
  if (parsed.value.protocol !== "https:") {
    return Result.err(
      new SamlMetadataError({
        message: `${label} must use HTTPS`,
        reason: "invalid_url",
      }),
    );
  }
  return Result.ok(parsed.value.toString());
};

const extractSigningCertificate = (idpSection: string): string | undefined => {
  const keyDescriptorRe =
    /<(?:[\w-]+:)?KeyDescriptor\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?KeyDescriptor>/gu;
  const certTagRe =
    /<(?:[\w-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?X509Certificate>/gu;

  const signingCandidates: string[] = [];
  const unspecifiedCandidates: string[] = [];

  for (const match of idpSection.matchAll(keyDescriptorRe)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const use = readAttribute(attrs, "use")?.toLowerCase();
    if (use === "encryption") {
      continue;
    }
    for (const certMatch of body.matchAll(certTagRe)) {
      const value = certMatch[1];
      if (value !== undefined) {
        if (use === "signing") {
          signingCandidates.push(value);
        } else {
          unspecifiedCandidates.push(value);
        }
      }
    }
  }

  for (const raw of [...signingCandidates, ...unspecifiedCandidates]) {
    const pem = formatPemCertificate(raw);
    if (pem !== undefined) {
      return pem;
    }
  }

  for (const certMatch of idpSection.matchAll(certTagRe)) {
    const value = certMatch[1];
    if (value !== undefined) {
      const pem = formatPemCertificate(value);
      if (pem !== undefined) {
        return pem;
      }
    }
  }

  return undefined;
};

const extractEntryPoint = (idpSection: string): string | undefined => {
  const ssoServiceRe = /<(?:[\w-]+:)?SingleSignOnService\b([^>]*?)\/?>/gu;
  for (const match of idpSection.matchAll(ssoServiceRe)) {
    const attrs = match[1] ?? "";
    const binding = readAttribute(attrs, "Binding");
    const location = readAttribute(attrs, "Location");
    if (
      binding === SAML_HTTP_REDIRECT_BINDING &&
      location !== undefined &&
      location !== ""
    ) {
      return location;
    }
  }
  return undefined;
};

/**
 * Extracts the IdP Entity ID, Single Sign-On URL, and signing X.509 certificate
 * from SAML 2.0 IdP federation metadata XML without expanding DTDs or entities.
 */
export const parseSamlIdpMetadataXml = (
  xml: string,
): Result<ParseSamlMetadataResponse, SamlMetadataError> => {
  const trimmed = xml.trim();
  if (trimmed.length === 0) {
    return Result.err(
      new SamlMetadataError({
        message: "SAML metadata XML is empty",
        reason: "invalid_document",
      }),
    );
  }
  if (Buffer.byteLength(trimmed, "utf-8") > SAML_METADATA_MAX_BYTES) {
    return Result.err(
      new SamlMetadataError({
        message: "SAML metadata XML exceeds the maximum allowed size",
        reason: "invalid_document",
      }),
    );
  }
  if (/<!(?:DOCTYPE|ENTITY)\b/iu.test(trimmed)) {
    return Result.err(
      new SamlMetadataError({
        message:
          "SAML metadata XML must not contain DOCTYPE or ENTITY declarations",
        reason: "invalid_document",
      }),
    );
  }

  const stripped = trimmed.replace(/<!--([\s\S]*?)-->/gu, "");
  const entityMatch = /<(?:[\w-]+:)?EntityDescriptor\b([^>]*)>/u.exec(stripped);
  const entityAttrs = entityMatch?.[1];
  const issuer =
    entityAttrs !== undefined
      ? readAttribute(entityAttrs, "entityID")
      : undefined;
  if (issuer === undefined || issuer === "") {
    return Result.err(
      new SamlMetadataError({
        message: "SAML metadata XML is missing EntityDescriptor entityID",
        reason: "invalid_document",
      }),
    );
  }

  const idpMatch =
    /<(?:[\w-]+:)?IDPSSODescriptor\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?IDPSSODescriptor>/u.exec(
      stripped,
    );
  const idpSection = idpMatch?.[1];
  if (idpSection === undefined) {
    return Result.err(
      new SamlMetadataError({
        message: "SAML metadata XML is missing IDPSSODescriptor",
        reason: "invalid_document",
      }),
    );
  }

  const rawEntryPoint = extractEntryPoint(idpSection);
  if (rawEntryPoint === undefined) {
    return Result.err(
      new SamlMetadataError({
        message:
          "SAML metadata XML is missing a SingleSignOnService HTTP-Redirect endpoint",
        reason: "invalid_document",
      }),
    );
  }
  const entryPointResult = validateHttpsUrl(
    rawEntryPoint,
    "SAML SingleSignOnService Location",
  );
  if (entryPointResult.isErr()) {
    return Result.err(
      new SamlMetadataError({
        message: entryPointResult.error.message,
        reason: "invalid_document",
      }),
    );
  }

  const cert = extractSigningCertificate(idpSection);
  if (cert === undefined) {
    return Result.err(
      new SamlMetadataError({
        message: "SAML metadata XML is missing a signing X509Certificate",
        reason: "invalid_document",
      }),
    );
  }

  const verifiedCert = Result.try({
    try: () => new X509Certificate(cert),
    catch: () =>
      new SamlMetadataError({
        message: "SAML metadata X509Certificate is not a valid PEM certificate",
        reason: "invalid_document",
      }),
  });
  if (verifiedCert.isErr()) {
    return verifiedCert;
  }

  return Result.ok({
    issuer,
    entryPoint: entryPointResult.value,
    cert,
  });
};

type ResolveSamlIdpMetadataOptions = {
  input: ParseSamlMetadataBody;
  permit: ThirdPartyOutboundPermit;
  fetchBytes?: typeof safeOutboundFetchBytes;
};

export const resolveSamlIdpMetadata = async ({
  input,
  permit,
  fetchBytes = safeOutboundFetchBytes,
}: ResolveSamlIdpMetadataOptions): Promise<
  Result<ParseSamlMetadataResponse, SamlMetadataError>
> => {
  switch (input.source) {
    case "xml":
      return parseSamlIdpMetadataXml(input.xml);
    case "url": {
      const urlResult = validateHttpsUrl(
        input.metadataUrl,
        "SAML metadata URL",
      );
      if (urlResult.isErr()) {
        return urlResult;
      }

      const response = await fetchBytes({
        url: urlResult.value,
        permit,
        maxBytes: SAML_METADATA_MAX_BYTES,
        timeout: { type: "total", ms: SAML_METADATA_TIMEOUT_MS },
        headers: {
          accept: "application/samlmetadata+xml, application/xml, text/xml",
        },
      });
      if (response.isErr()) {
        return Result.err(
          new SamlMetadataError({
            message: "Could not fetch the SAML metadata document",
            reason: "fetch_failed",
          }),
        );
      }
      if (response.value.status < 200 || response.value.status >= 300) {
        return Result.err(
          new SamlMetadataError({
            message: `SAML metadata endpoint returned HTTP ${response.value.status}`,
            reason: "fetch_failed",
          }),
        );
      }

      const decoded = Result.try({
        try: () =>
          new TextDecoder("utf-8", { fatal: true }).decode(response.value.body),
        catch: () =>
          new SamlMetadataError({
            message: "SAML metadata response is not valid UTF-8",
            reason: "invalid_document",
          }),
      });
      if (decoded.isErr()) {
        return decoded;
      }

      return parseSamlIdpMetadataXml(decoded.value);
    }
    default:
      input satisfies never;
      return panic("Unhandled SAML metadata source");
  }
};
