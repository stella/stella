import { describe, expect, test } from "bun:test";

import {
  chainReachesRoot,
  completeCertificateChain,
} from "@/api/lib/pdf-signing/certificate-chain";
import type { PkiFetcher } from "@/api/lib/pdf-signing/pki-fetch";
import { safePkiFetch } from "@/api/lib/pdf-signing/pki-fetch";
import { createTestCertificate } from "@/api/tests/helpers/test-pki";
import type { TestCertificate } from "@/api/tests/helpers/test-pki";

const ROOT_URL = "http://pki.example/root.cer";
const INTERMEDIATE_URL = "http://pki.example/intermediate.cer";

const buildHierarchy = async () => {
  const root = await createTestCertificate({
    commonName: "Test Root",
    isCa: true,
  });
  const intermediate = await createTestCertificate({
    caIssuersUrl: ROOT_URL,
    commonName: "Test Issuing CA",
    isCa: true,
    issuer: root,
  });
  const leaf = await createTestCertificate({
    caIssuersUrl: INTERMEDIATE_URL,
    commonName: "Jane Counsel",
    issuer: intermediate,
  });
  return { intermediate, leaf, root };
};

/** A fake distribution point: serves fixed bytes and records every request. */
const servingFetcher = (
  served: Record<string, TestCertificate | Uint8Array>,
) => {
  const requested: string[] = [];
  const fetcher: PkiFetcher = async ({ url }) => {
    requested.push(url);
    const entry = served[url];
    if (entry === undefined) {
      return null;
    }
    return entry instanceof Uint8Array ? entry : entry.der;
  };
  return { fetcher, requested };
};

const hex = (chain: readonly Uint8Array[]) =>
  chain.map((der) => Buffer.from(der).toString("hex"));

describe("completing the signer's certificate chain", () => {
  test("orders the issuers the desktop sent and drops the ones that issued nothing", async () => {
    const { intermediate, leaf, root } = await buildHierarchy();
    const stranger = await createTestCertificate({ commonName: "Unrelated" });
    const { fetcher, requested } = servingFetcher({});

    const completed = await completeCertificateChain({
      candidates: [root.der, stranger.der, intermediate.der],
      certificate: leaf.der,
      fetcher,
    });

    expect(hex(completed.chain)).toEqual(hex([intermediate.der, root.der]));
    expect(completed.complete).toBe(true);
    // Everything needed was offered, so nothing was fetched.
    expect(requested).toEqual([]);
  });

  test("fetches missing issuers from the AIA caIssuers URLs, level by level", async () => {
    const { intermediate, leaf, root } = await buildHierarchy();
    const { fetcher, requested } = servingFetcher({
      [INTERMEDIATE_URL]: intermediate,
      [ROOT_URL]: root,
    });

    const completed = await completeCertificateChain({
      candidates: [],
      certificate: leaf.der,
      fetcher,
    });

    expect(hex(completed.chain)).toEqual(hex([intermediate.der, root.der]));
    expect(completed.complete).toBe(true);
    expect(requested).toEqual([INTERMEDIATE_URL, ROOT_URL]);
    expect(chainReachesRoot(leaf.der, completed.chain)).toBe(true);
  });

  test("refuses a downloaded certificate that did not sign the one below it", async () => {
    const { leaf } = await buildHierarchy();
    // Same subject name as the real issuing CA, different key: it would
    // pass a name check and must still be refused.
    const impostor = await createTestCertificate({
      commonName: "Test Issuing CA",
      isCa: true,
    });
    const { fetcher } = servingFetcher({ [INTERMEDIATE_URL]: impostor });

    const completed = await completeCertificateChain({
      candidates: [impostor.der],
      certificate: leaf.der,
      fetcher,
    });

    expect(completed.chain).toEqual([]);
    expect(completed.complete).toBe(false);
    expect(chainReachesRoot(leaf.der, completed.chain)).toBe(false);
  });

  test("keeps what it found when an issuer cannot be fetched", async () => {
    const { intermediate, leaf } = await buildHierarchy();
    const { fetcher, requested } = servingFetcher({
      [INTERMEDIATE_URL]: intermediate,
      [ROOT_URL]: new TextEncoder().encode("<html>not a certificate</html>"),
    });

    const completed = await completeCertificateChain({
      candidates: [],
      certificate: leaf.der,
      fetcher,
    });

    expect(hex(completed.chain)).toEqual(hex([intermediate.der]));
    expect(completed.complete).toBe(false);
    expect(requested).toEqual([INTERMEDIATE_URL, ROOT_URL]);
  });

  test("treats a self-signed certificate as its own complete chain", async () => {
    const own = await createTestCertificate({ commonName: "Self" });

    const completed = await completeCertificateChain({
      candidates: [],
      certificate: own.der,
      fetcher: servingFetcher({}).fetcher,
    });

    expect(completed).toEqual({ chain: [], complete: true });
  });
});

describe("fetching PKI data a certificate points at", () => {
  test.each([
    "http://127.0.0.1/root.cer",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/root.cer",
    "http://localhost/root.cer",
    "http://ca.internal/root.cer",
    "file:///etc/passwd",
    "ldap://directory.example/cn=CA",
  ])("never reaches %s", async (url) => {
    expect(await safePkiFetch({ maxBytes: 1024, method: "GET", url })).toBe(
      null,
    );
  });
});
