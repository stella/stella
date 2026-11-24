import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

import {
  parseSamlIdpMetadataXml,
  resolveSamlIdpMetadata,
} from "./saml-metadata";

const SAMPLE_CERT_BODY =
  "MIIC9DCCAdygAwIBAgIUdfcejhLSC2sj4RLvzhg/PR7RWDUwDQYJKoZIhvcNAQELBQAwGjEYMBYGA1UEAwwPaWRwLmV4YW1wbGUuY29tMB4XDTI2MTEyNDEyMjQxM1oXDTM2MTEyMTEyMjQxM1owGjEYMBYGA1UEAwwPaWRwLmV4YW1wbGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvrSZpQ4IRJRc8HzcEvjzEt4RRw1USqXBBF+ktauQ0Zmjk48dXajQlg8f3YtOxUI4GaJjIQC07USBvp445yZLonO5Wisn6qcR5yzZzUWa97QlfD92p75tAnSVh1wglci7hySkLZjvDRAA45MDe+shKmj/V0cISgMZjEb9WbDMyNrzS6UrZZwUywF5vG7JmBJu1eAYDurup9IycpyeP4FGBDCZhXoTKhFy1n4HDwDVW88+fd7E3muvnNiWKM87RtRR4pRtmHUB0X5fkOR0USozPu00rr8nb9E2orBToE0TSoH3Dt6FkCQiXh1Epyy2hQufberdhFqqd2TupjInvZC89wIDAQABozIwMDAdBgNVHQ4EFgQUtODknPvLjLtF+4mTY60++Fwlj3cwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEArSiELPLWB4a6vtYALsrRaCf/vHyNAXwzRyGiinr3bQVUxakgglIPWrqDa0a1HrL3cobBiX21OYnNiSgHo36z8eBn/bvkUiDgudF8AzuOhOpHhtbCmXGYGLlJR5CXsNZjJ6/OCRZ6Uey3ZQ0D2lLfsZNpyh3F64vurzH/qzYtOFy1jh64KPi5BwR3it853JpXnMoNFrOI9rO5FkDBE2CFcEZm8PYJMB/xGhFANwK3HaK8m3oCeUUeoHtRy8jmXmaaNXR2YPaz9MoErmTjybUy6umPb2r0aNrR8s5J4NLbhbQo8W8P/3Y5HyBI4IafBp3KWNv9AojNiMZhBIHsu0K80g==";

const ENTRA_METADATA_XML = `<?xml version="1.0" encoding="utf-8"?>
<EntityDescriptor ID="_abc" entityID="https://sts.windows.net/tenant-123/" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="encryption">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data>
          <X509Certificate>QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==</X509Certificate>
        </X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data>
          <X509Certificate>${SAMPLE_CERT_BODY}</X509Certificate>
        </X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://login.microsoftonline.com/tenant-123/saml2/post" />
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://login.microsoftonline.com/tenant-123/saml2" />
  </IDPSSODescriptor>
</EntityDescriptor>`;

describe("parseSamlIdpMetadataXml", () => {
  test("extracts entityID, HTTP-Redirect entryPoint, and signing X.509 PEM certificate", () => {
    const result = parseSamlIdpMetadataXml(ENTRA_METADATA_XML);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) {
      return;
    }
    expect(result.value.issuer).toBe("https://sts.windows.net/tenant-123/");
    expect(result.value.entryPoint).toBe(
      "https://login.microsoftonline.com/tenant-123/saml2",
    );
    expect(result.value.cert).toContain("-----BEGIN CERTIFICATE-----");
    expect(result.value.cert).toContain("-----END CERTIFICATE-----");
  });

  test("supports namespace-prefixed md: and ds: tags and HTTP-POST fallback", () => {
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://www.okta.com/exk123">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor>
          <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
            <ds:X509Data><ds:X509Certificate>${SAMPLE_CERT_BODY}</ds:X509Certificate></ds:X509Data>
          </ds:KeyInfo>
        </md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://firm.okta.com/app/firm/exk123/sso/saml" />
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    const result = parseSamlIdpMetadataXml(xml);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) {
      return;
    }
    expect(result.value.issuer).toBe("http://www.okta.com/exk123");
    expect(result.value.entryPoint).toBe(
      "https://firm.okta.com/app/firm/exk123/sso/saml",
    );
  });

  test("rejects XML containing DOCTYPE or ENTITY declarations", () => {
    const xxe = `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${ENTRA_METADATA_XML}`;
    const result = parseSamlIdpMetadataXml(xxe);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("invalid_document");
    }
  });

  test("rejects non-HTTPS SingleSignOnService Location", () => {
    const insecure = ENTRA_METADATA_XML.replaceAll(
      "https://login.microsoftonline.com/",
      "http://login.microsoftonline.com/",
    );
    const result = parseSamlIdpMetadataXml(insecure);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("invalid_document");
    }
  });
});

describe("resolveSamlIdpMetadata", () => {
  test("fetches and parses metadata over HTTPS through fetchBytes", async () => {
    const result = await resolveSamlIdpMetadata({
      input: {
        source: "url",
        metadataUrl:
          "https://login.microsoftonline.com/tenant-123/federationmetadata/2007-06/federationmetadata.xml",
      },
      permit: grantThirdPartyOutboundPermit(),
      fetchBytes: async () => {
        const encoded = new TextEncoder().encode(ENTRA_METADATA_XML);
        return await Promise.resolve(
          Result.ok({
            status: 200,
            ok: true,
            headers: new Headers({ "content-type": "application/xml" }),
            body: encoded.buffer.slice(
              encoded.byteOffset,
              encoded.byteOffset + encoded.byteLength,
            ),
          }),
        );
      },
    });
    expect(result.isOk()).toBe(true);
  });

  test("rejects non-HTTPS metadata URLs", async () => {
    const result = await resolveSamlIdpMetadata({
      input: {
        source: "url",
        metadataUrl: "http://idp.example.com/metadata.xml",
      },
      permit: grantThirdPartyOutboundPermit(),
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("invalid_url");
    }
  });
});
