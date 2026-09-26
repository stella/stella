import * as asn1js from "asn1js";
import { describe, expect, test } from "bun:test";
import * as pkijs from "pkijs";

import type { PkiFetcher } from "@/api/lib/files/pdf-signing/pki-fetch";
import { createTrackedRevocationProvider } from "@/api/lib/files/pdf-signing/revocation";
import { findRevokedCertificates } from "@/api/lib/files/pdf-signing/validation-data";
import {
  createTestCertificate,
  createTestCrl,
  createTestOcspResponse,
} from "@/api/tests/helpers/test-pki";

const CRL_URL = "http://crl.example/issuing.crl";
const OCSP_URL = "http://ocsp.example/";

const buildLeaf = async () => {
  const root = await createTestCertificate({ commonName: "Root", isCa: true });
  const leaf = await createTestCertificate({
    commonName: "Jane Counsel",
    crlUrl: CRL_URL,
    issuer: root,
    ocspUrl: OCSP_URL,
  });
  return { leaf, root };
};

/** RFC 6960 `tryLater`: a responder that answered without a status. */
const unsuccessfulOcspResponse = () =>
  new Uint8Array(
    new pkijs.OCSPResponse({
      responseStatus: new asn1js.Enumerated({ value: 3 }),
    })
      .toSchema()
      .toBER(false),
  );

describe("revocation data for long-term validation", () => {
  test("posts an OCSP request to the certificate's responder", async () => {
    const { leaf, root } = await buildLeaf();
    const requests: { method: string; url: string; contentType?: string }[] =
      [];
    const fetcher: PkiFetcher = async ({ contentType, method, url }) => {
      requests.push({ contentType, method, url });
      return null;
    };

    const provider = createTrackedRevocationProvider(fetcher);
    expect(await provider.getOCSP(leaf.der, root.der)).toBe(null);

    expect(requests).toEqual([
      {
        contentType: "application/ocsp-request",
        method: "POST",
        url: OCSP_URL,
      },
    ]);
  });

  test("counts a certificate covered only once real revocation data arrived", async () => {
    const { leaf, root } = await buildLeaf();
    const crl = await createTestCrl(root);
    const fetcher: PkiFetcher = async ({ url }) =>
      url === OCSP_URL ? unsuccessfulOcspResponse() : crl;

    const provider = createTrackedRevocationProvider(fetcher);

    // A responder that answered "try later" is not revocation data.
    expect(await provider.getOCSP(leaf.der, root.der)).toBe(null);
    expect(provider.covers(leaf.der)).toBe(false);

    expect(await provider.getCRL(leaf.der, root.der)).toEqual(crl);
    expect(provider.covers(leaf.der)).toBe(true);
    expect(provider.covers(root.der)).toBe(false);
  });

  test("ignores a distribution point that serves something other than a CRL", async () => {
    const { leaf, root } = await buildLeaf();
    const provider = createTrackedRevocationProvider(async () =>
      new TextEncoder().encode("<html>maintenance</html>"),
    );

    expect(await provider.getCRL(leaf.der, root.der)).toBe(null);
    expect(provider.covers(leaf.der)).toBe(false);
  });

  test("reads a revoked OCSP answer as revoked, never as covered", async () => {
    const { leaf, root } = await buildLeaf();
    const revoked = await createTestOcspResponse({
      issuer: root,
      status: "revoked",
      subject: leaf,
    });
    const provider = createTrackedRevocationProvider(async () => revoked);

    expect(await provider.getOCSP(leaf.der, root.der)).toEqual(revoked);
    expect(provider.isRevoked(leaf.der)).toBe(true);
    expect(provider.covers(leaf.der)).toBe(false);
  });

  test("reads a good OCSP answer as covered", async () => {
    const { leaf, root } = await buildLeaf();
    const good = await createTestOcspResponse({
      issuer: root,
      status: "good",
      subject: leaf,
    });
    const provider = createTrackedRevocationProvider(async () => good);

    await provider.getOCSP(leaf.der, root.der);
    expect(provider.covers(leaf.der)).toBe(true);
    expect(provider.isRevoked(leaf.der)).toBe(false);
  });

  test("ignores an OCSP answer about another certificate", async () => {
    const { leaf, root } = await buildLeaf();
    const other = await createTestCertificate({
      commonName: "Someone else",
      issuer: root,
    });
    const aboutOther = await createTestOcspResponse({
      issuer: root,
      status: "revoked",
      subject: other,
    });
    const provider = createTrackedRevocationProvider(async () => aboutOther);

    expect(await provider.getOCSP(leaf.der, root.der)).toBe(null);
    expect(provider.isRevoked(leaf.der)).toBe(false);
  });

  test("only trusts a CRL the issuer signed", async () => {
    const { leaf, root } = await buildLeaf();
    const impostor = await createTestCertificate({
      commonName: "Root",
      isCa: true,
    });
    // Same issuer name, wrong key: it must not revoke, nor count as data.
    const forged = await createTestCrl(impostor, [leaf]);
    const provider = createTrackedRevocationProvider(async ({ url }) =>
      url === CRL_URL ? forged : null,
    );

    expect(await provider.getCRL(leaf.der, root.der)).toBe(null);
    expect(provider.isRevoked(leaf.der)).toBe(false);
    expect(provider.covers(leaf.der)).toBe(false);
  });

  test("finds every revoked certificate of a signer chain", async () => {
    const { leaf, root } = await buildLeaf();
    const crl = await createTestCrl(root, [leaf]);

    const { revoked } = await findRevokedCertificates({
      provider: createTrackedRevocationProvider(async ({ url }) =>
        url === CRL_URL ? crl : null,
      ),
      signerChain: [leaf.der, root.der],
    });

    expect(revoked).toEqual([leaf.der]);
  });

  describe("authenticity and currency", () => {
    const serve = (bytes: Uint8Array) =>
      createTrackedRevocationProvider(async () => bytes);

    test("ignores a good OCSP answer the issuer did not sign", async () => {
      const { leaf, root } = await buildLeaf();
      // Same name as the real issuer, different key: a forged "good" that
      // would otherwise hide a revocation.
      const impostor = await createTestCertificate({
        commonName: "Root",
        isCa: true,
      });
      const forged = await createTestOcspResponse({
        issuer: root,
        responder: impostor,
        status: "good",
        subject: leaf,
      });
      const provider = serve(forged);

      expect(await provider.getOCSP(leaf.der, root.der)).toBe(null);
      expect(provider.covers(leaf.der)).toBe(false);
    });

    test("ignores a good OCSP answer past its next update", async () => {
      const { leaf, root } = await buildLeaf();
      const day = 86_400_000;
      const stale = await createTestOcspResponse({
        issuer: root,
        nextUpdate: new Date(Date.now() - 9 * day),
        status: "good",
        subject: leaf,
        thisUpdate: new Date(Date.now() - 10 * day),
      });
      const provider = serve(stale);

      expect(await provider.getOCSP(leaf.der, root.der)).toBe(null);
      expect(provider.covers(leaf.der)).toBe(false);
    });

    test("accepts a responder the issuer delegated for OCSP, and only that", async () => {
      const { leaf, root } = await buildLeaf();
      const delegated = await createTestCertificate({
        commonName: "Root OCSP responder",
        extendedKeyUsages: ["1.3.6.1.5.5.7.3.9"],
        issuer: root,
      });
      const undelegated = await createTestCertificate({
        commonName: "Root web server",
        extendedKeyUsages: ["1.3.6.1.5.5.7.3.1"],
        issuer: root,
      });

      const byDelegate = serve(
        await createTestOcspResponse({
          issuer: root,
          responder: delegated,
          status: "good",
          subject: leaf,
        }),
      );
      await byDelegate.getOCSP(leaf.der, root.der);
      expect(byDelegate.covers(leaf.der)).toBe(true);

      const byOther = serve(
        await createTestOcspResponse({
          issuer: root,
          responder: undelegated,
          status: "good",
          subject: leaf,
        }),
      );
      expect(await byOther.getOCSP(leaf.der, root.der)).toBe(null);
      expect(byOther.covers(leaf.der)).toBe(false);
    });

    test("ignores a delegated responder whose own certificate has expired", async () => {
      const { leaf, root } = await buildLeaf();
      const day = 86_400_000;
      // Correctly issued and authorized for OCSP, but no longer valid: its
      // key may have been retired, so what it signs proves nothing now.
      const expired = await createTestCertificate({
        commonName: "Root OCSP responder",
        extendedKeyUsages: ["1.3.6.1.5.5.7.3.9"],
        issuer: root,
        notAfter: new Date(Date.now() - day),
        notBefore: new Date(Date.now() - 30 * day),
      });
      const provider = serve(
        await createTestOcspResponse({
          issuer: root,
          responder: expired,
          status: "good",
          subject: leaf,
        }),
      );

      expect(await provider.getOCSP(leaf.der, root.der)).toBe(null);
      expect(provider.covers(leaf.der)).toBe(false);
    });

    test("ignores a CRL past its next update", async () => {
      const { leaf, root } = await buildLeaf();
      const day = 86_400_000;
      // An old list, from before the certificate was revoked, must not
      // stand in for a current one.
      const stale = await createTestCrl(root, [], {
        nextUpdate: new Date(Date.now() - 2 * day),
        thisUpdate: new Date(Date.now() - 9 * day),
      });
      const provider = createTrackedRevocationProvider(async ({ url }) =>
        url === CRL_URL ? stale : null,
      );

      expect(await provider.getCRL(leaf.der, root.der)).toBe(null);
      expect(provider.covers(leaf.der)).toBe(false);
    });
  });
});
