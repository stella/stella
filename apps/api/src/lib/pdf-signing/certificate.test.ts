import { describe, expect, test } from "bun:test";

import { inspectSigningCertificate } from "@/api/lib/pdf-signing/certificate";
import {
  createSelfSignedCertificate,
  KEY_USAGE,
} from "@/api/tests/helpers/self-signed-certificate";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const HOUR_MS = 3_600_000;

describe("signing certificate inspection", () => {
  test("derives the key family and CMS algorithm from the certificate, not the client", async () => {
    const rsa = await createSelfSignedCertificate({
      notBefore: new Date(NOW.getTime() - HOUR_MS),
      notAfter: new Date(NOW.getTime() + HOUR_MS),
    });
    const ec = await createSelfSignedCertificate({
      keyType: "EC",
      notBefore: new Date(NOW.getTime() - HOUR_MS),
      notAfter: new Date(NOW.getTime() + HOUR_MS),
    });

    expect(inspectSigningCertificate(rsa.der, NOW)).toMatchObject({
      status: "accepted",
      keyType: "RSA",
      signatureAlgorithm: "RSASSA-PKCS1-v1_5",
    });
    expect(inspectSigningCertificate(ec.der, NOW)).toMatchObject({
      status: "accepted",
      keyType: "EC",
      signatureAlgorithm: "ECDSA",
    });
  });

  test("fingerprints the exact bytes it was given", async () => {
    const { der } = await createSelfSignedCertificate({
      notBefore: new Date(NOW.getTime() - HOUR_MS),
      notAfter: new Date(NOW.getTime() + HOUR_MS),
    });

    expect(inspectSigningCertificate(der, NOW)).toMatchObject({
      sha256Hex: new Bun.CryptoHasher("sha256").update(der).digest("hex"),
    });
  });

  test("refuses a certificate outside its validity window", async () => {
    const { der } = await createSelfSignedCertificate({
      notBefore: new Date(NOW.getTime() - 2 * HOUR_MS),
      notAfter: new Date(NOW.getTime() - HOUR_MS),
    });

    // The same certificate is usable inside the window, so the rejection is
    // the window and not something else about this certificate.
    expect(
      inspectSigningCertificate(der, new Date(NOW.getTime() - 90 * 60_000)),
    ).toMatchObject({ status: "accepted" });
    expect(inspectSigningCertificate(der, NOW)).toEqual({
      status: "rejected",
      reason: "expired",
    });
  });

  test("refuses a certificate that is not valid yet", async () => {
    const { der } = await createSelfSignedCertificate({
      notBefore: new Date(NOW.getTime() + HOUR_MS),
      notAfter: new Date(NOW.getTime() + 2 * HOUR_MS),
    });

    expect(inspectSigningCertificate(der, NOW)).toEqual({
      status: "rejected",
      reason: "not_yet_valid",
    });
  });

  test("requires a key usage that permits signing when the extension is present", async () => {
    const window = {
      notBefore: new Date(NOW.getTime() - HOUR_MS),
      notAfter: new Date(NOW.getTime() + HOUR_MS),
    };
    const encipherment = await createSelfSignedCertificate({
      ...window,
      keyUsage: KEY_USAGE.keyEncipherment,
    });
    const nonRepudiation = await createSelfSignedCertificate({
      ...window,
      keyUsage: KEY_USAGE.nonRepudiation,
    });
    const unconstrained = await createSelfSignedCertificate({
      ...window,
      keyUsage: "none",
    });

    expect(inspectSigningCertificate(encipherment.der, NOW)).toEqual({
      status: "rejected",
      reason: "key_usage_forbids_signing",
    });
    // nonRepudiation alone is what a qualified signing certificate carries.
    expect(inspectSigningCertificate(nonRepudiation.der, NOW)).toMatchObject({
      status: "accepted",
    });
    // No KeyUsage extension means unconstrained (RFC 5280 4.2.1.3).
    expect(inspectSigningCertificate(unconstrained.der, NOW)).toMatchObject({
      status: "accepted",
    });
  });

  test("refuses bytes that are not a certificate", () => {
    expect(
      inspectSigningCertificate(
        new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
        NOW,
      ),
    ).toEqual({ status: "rejected", reason: "malformed" });
  });
});
