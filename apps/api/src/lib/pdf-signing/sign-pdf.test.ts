import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import {
  applySignature,
  captureSigningDigest,
  PdfSigningCertifiedDocumentError,
  PdfSigningDigestMismatchError,
} from "@/api/lib/pdf-signing/sign-pdf";
import { buildCertifiedPdf } from "@/api/tests/helpers/certified-pdf";
import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";
import { createTestTimestampAuthority } from "@/api/tests/helpers/timestamp-token";

/** DigestInfo header for SHA-256, RFC 8017 9.2 step 2. */
const SHA256_DIGEST_INFO_PREFIX = Buffer.from(
  "3031300d060960864801650304020105000420",
  "hex",
);

/**
 * The desktop half: a keychain signs a digest, never a message. Node's
 * private-key PKCS#1 operation over the DigestInfo is exactly what
 * `SecKey::create_signature(RSASignatureDigestPKCS1v15SHA256)` produces.
 */
const signDigestLikeAKeychain = async (
  privateKey: CryptoKey,
  digestHex: string,
) => {
  const key = crypto.createPrivateKey({
    key: Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)),
    format: "der",
    type: "pkcs8",
  });
  return new Uint8Array(
    crypto.privateEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.concat([SHA256_DIGEST_INFO_PREFIX, Buffer.from(digestHex, "hex")]),
    ),
  );
};

const buildBasePdf = async () => {
  const created = PDF.create();
  created.addPage({ width: 300, height: 400 });
  // Signing appends an incremental update, which a newly created instance
  // cannot do; round-tripping through bytes is how a stored PDF arrives.
  return await created.save();
};

const SIGNING_TIME = new Date("2026-06-01T12:00:00.000Z");

const buildInvocation = async () => {
  const { der, privateKey } = await createSelfSignedCertificate({
    notBefore: new Date(SIGNING_TIME.getTime() - 3_600_000),
    notAfter: new Date(SIGNING_TIME.getTime() + 3_600_000),
  });
  return {
    invocation: {
      basePdf: await buildBasePdf(),
      certificate: der,
      certificateChain: [],
      keyType: "RSA" as const,
      location: null,
      reason: null,
      signatureAlgorithm: "RSASSA-PKCS1-v1_5" as const,
      signingTime: SIGNING_TIME,
    },
    privateKey,
  };
};

describe("two-phase PDF signing", () => {
  test("publishes a digest the desktop can sign and then accepts that signature", async () => {
    const { invocation, privateKey } = await buildInvocation();

    const digestHex = await captureSigningDigest(invocation);
    expect(digestHex).toMatch(/^[0-9a-f]{64}$/u);

    const signature = await signDigestLikeAKeychain(privateKey, digestHex);
    const { bytes: signed } = await applySignature({
      ...invocation,
      expectedDigestHex: digestHex,
      signature,
      timestampAuthorities: [],
    });

    // Phase 2 only returns bytes when LibPDF asked it to sign exactly the
    // digest phase 1 published: the two phases agreeing is the invariant.
    expect(Buffer.from(signed.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(signed.byteLength).toBeGreaterThan(invocation.basePdf.byteLength);
    expect(await PDF.load(signed)).toBeDefined();

    // The desktop's exact bytes are what the document carries.
    const document = Buffer.from(signed).toString("latin1");
    const signatureHex = Buffer.from(signature).toString("hex");
    expect(
      document.includes(signatureHex) ||
        document.includes(signatureHex.toUpperCase()),
    ).toBe(true);
  });

  test("the signature the desktop produced verifies against its certificate", async () => {
    const { invocation, privateKey } = await buildInvocation();
    const digestHex = await captureSigningDigest(invocation);
    const signature = await signDigestLikeAKeychain(privateKey, digestHex);

    const recovered = crypto.publicDecrypt(
      {
        key: crypto.createPublicKey(
          crypto.createPrivateKey({
            key: Buffer.from(
              await crypto.subtle.exportKey("pkcs8", privateKey),
            ),
            format: "der",
            type: "pkcs8",
          }),
        ),
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(signature),
    );

    expect(recovered.toString("hex")).toBe(
      Buffer.concat([
        SHA256_DIGEST_INFO_PREFIX,
        Buffer.from(digestHex, "hex"),
      ]).toString("hex"),
    );
  });

  test("the digest depends only on the inputs both phases replay", async () => {
    const { invocation } = await buildInvocation();

    const digestHex = await captureSigningDigest(invocation);
    expect(await captureSigningDigest(invocation)).toBe(digestHex);

    // The signing time is a signed attribute, so it must be persisted in
    // phase 1 rather than re-read from the clock in phase 2.
    const laterTime = await captureSigningDigest({
      ...invocation,
      signingTime: new Date(SIGNING_TIME.getTime() + 60_000),
    });
    expect(laterTime).not.toBe(digestHex);

    // The reason lands in the signature dictionary, which the hashed range
    // covers, so it changes what has to be signed too.
    const withReason = await captureSigningDigest({
      ...invocation,
      reason: "Approved",
    });
    expect(withReason).not.toBe(digestHex);
  });

  test("refuses to embed a signature prepared for different bytes", async () => {
    const { invocation, privateKey } = await buildInvocation();
    const digestHex = await captureSigningDigest(invocation);
    const signature = await signDigestLikeAKeychain(privateKey, digestHex);

    const otherDigestHex = new Bun.CryptoHasher("sha256")
      .update("a digest for some other document")
      .digest("hex");
    expect(otherDigestHex).not.toBe(digestHex);

    const rejected = await applySignature({
      ...invocation,
      expectedDigestHex: otherDigestHex,
      signature,
      timestampAuthorities: [],
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(PdfSigningDigestMismatchError);
  });

  test("refuses before any digest exists when a certification forbids changes", async () => {
    const { invocation } = await buildInvocation();

    const locked = await captureSigningDigest({
      ...invocation,
      basePdf: await buildCertifiedPdf({ permission: 1 }),
    }).catch((error: unknown) => error);
    expect(locked).toBeInstanceOf(PdfSigningCertifiedDocumentError);

    // Form filling and signing (P=2) and annotating (P=3) both admit an
    // approval signature, so those certifications still prepare a digest.
    for (const permission of [2, 3]) {
      expect(
        await captureSigningDigest({
          ...invocation,
          basePdf: await buildCertifiedPdf({ permission }),
        }),
      ).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("takes trusted time from the next authority when one fails", async () => {
    const { invocation, privateKey } = await buildInvocation();
    const digestHex = await captureSigningDigest(invocation);
    const signature = await signDigestLikeAKeychain(privateKey, digestHex);
    const working = await createTestTimestampAuthority();

    const applied = await applySignature({
      ...invocation,
      expectedDigestHex: digestHex,
      signature,
      timestampAuthorities: [
        {
          authority: {
            timestamp: async () => {
              throw new Error("authority unreachable");
            },
          },
          url: "https://tsa-down.example/",
        },
        { authority: working, url: "https://tsa-up.example/" },
      ],
    });

    // The timestamp is phase 2's alone: adding it did not change the digest
    // phase 1 published, or the signer above would have refused.
    expect(working.issued()).toBe(1);
    expect(applied.timestampAuthorityUrl).toBe("https://tsa-up.example/");
    expect(applied.bytes.byteLength).toBeGreaterThan(
      invocation.basePdf.byteLength,
    );
  });
});
