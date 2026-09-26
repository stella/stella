import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { captureSigningDigest } from "@/api/lib/files/pdf-signing/sign-pdf";
import { verifyDesktopSignature } from "@/api/lib/files/pdf-signing/verify-signature";
import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";

const SIGNING_TIME = new Date("2026-06-01T12:00:00.000Z");

/** Node's view of a WebCrypto private key, to sign the way a keychain does. */
const nodeKey = async (privateKey: CryptoKey) =>
  crypto.createPrivateKey({
    key: Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)),
    format: "der",
    type: "pkcs8",
  });

const prepare = async (keyType: "RSA" | "EC") => {
  const { der, privateKey } = await createSelfSignedCertificate({
    keyType,
    notAfter: new Date(SIGNING_TIME.getTime() + 3_600_000),
    notBefore: new Date(SIGNING_TIME.getTime() - 3_600_000),
  });
  const created = PDF.create();
  created.addPage({ width: 300, height: 400 });
  const { signedAttributes } = await captureSigningDigest({
    basePdf: await created.save(),
    certificate: der,
    certificateChain: [],
    keyType,
    location: null,
    placeholderSize: 16_384,
    reason: null,
    reserveTimestamp: false,
    signatureAlgorithm: keyType === "RSA" ? "RSASSA-PKCS1-v1_5" : "ECDSA",
    signingTime: SIGNING_TIME,
    stamp: null,
  });
  return { der, key: await nodeKey(privateKey), signedAttributes };
};

describe("verifying the desktop's signature before embedding it", () => {
  test.each(["RSA", "EC"] as const)(
    "accepts a %s signature over the signed attributes",
    async (keyType) => {
      const { der, key, signedAttributes } = await prepare(keyType);
      const signature = crypto.sign("sha256", signedAttributes, {
        key,
        dsaEncoding: "der",
      });

      expect(
        verifyDesktopSignature({
          certificate: der,
          keyType,
          signature,
          signedAttributes,
        }),
      ).toBe(true);
    },
  );

  test.each(["RSA", "EC"] as const)(
    "refuses a %s signature made with a key the certificate does not hold",
    async (keyType) => {
      const { der, signedAttributes } = await prepare(keyType);
      const other = await prepare(keyType);
      const signature = crypto.sign("sha256", signedAttributes, {
        key: other.key,
        dsaEncoding: "der",
      });

      expect(
        verifyDesktopSignature({
          certificate: der,
          keyType,
          signature,
          signedAttributes,
        }),
      ).toBe(false);
    },
  );

  test("refuses a signature over different signed attributes", async () => {
    const { der, key, signedAttributes } = await prepare("RSA");
    const tampered = new Uint8Array(signedAttributes);
    tampered[tampered.length - 1] = tampered.at(-1) === 0 ? 1 : 0;
    const signature = crypto.sign("sha256", tampered, key);

    expect(
      verifyDesktopSignature({
        certificate: der,
        keyType: "RSA",
        signature,
        signedAttributes,
      }),
    ).toBe(false);
  });

  test("refuses bytes that are not a signature at all", async () => {
    const { der, signedAttributes } = await prepare("EC");

    for (const signature of [new Uint8Array(0), new Uint8Array(64).fill(7)]) {
      expect(
        verifyDesktopSignature({
          certificate: der,
          keyType: "EC",
          signature,
          signedAttributes,
        }),
      ).toBe(false);
    }
  });
});
