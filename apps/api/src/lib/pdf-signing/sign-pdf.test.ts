import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { createTrackedRevocationProvider } from "@/api/lib/pdf-signing/revocation";
import {
  applySignature,
  captureSigningDigest,
  PdfSigningCertifiedDocumentError,
  PdfSigningDigestMismatchError,
  PdfSigningPlaceholderTooSmallError,
  signaturePlaceholderSize,
} from "@/api/lib/pdf-signing/sign-pdf";
import { buildCertifiedPdf } from "@/api/tests/helpers/certified-pdf";
import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";
import {
  createTestCertificate,
  createTestCrl,
} from "@/api/tests/helpers/test-pki";
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

const digestOf = async (
  invocation: Parameters<typeof captureSigningDigest>[0],
) => (await captureSigningDigest(invocation)).digestHex;

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
      placeholderSize: signaturePlaceholderSize({
        certificate: der,
        certificateChain: [],
        timestamped: true,
      }),
      reason: null,
      reserveTimestamp: true,
      signatureAlgorithm: "RSASSA-PKCS1-v1_5" as const,
      signingTime: SIGNING_TIME,
    },
    privateKey,
  };
};

describe("two-phase PDF signing", () => {
  test("publishes a digest the desktop can sign and then accepts that signature", async () => {
    const { invocation, privateKey } = await buildInvocation();

    const digestHex = await digestOf(invocation);
    expect(digestHex).toMatch(/^[0-9a-f]{64}$/u);

    const signature = await signDigestLikeAKeychain(privateKey, digestHex);
    const { bytes: signed } = await applySignature({
      ...invocation,
      expectedDigestHex: digestHex,
      signature,
      certificateChainComplete: true,
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
    const digestHex = await digestOf(invocation);
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

    const digestHex = await digestOf(invocation);
    expect(await digestOf(invocation)).toBe(digestHex);

    // The signing time is a signed attribute, so it must be persisted in
    // phase 1 rather than re-read from the clock in phase 2.
    const laterTime = await digestOf({
      ...invocation,
      signingTime: new Date(SIGNING_TIME.getTime() + 60_000),
    });
    expect(laterTime).not.toBe(digestHex);

    // The reason lands in the signature dictionary, which the hashed range
    // covers, so it changes what has to be signed too.
    const withReason = await digestOf({
      ...invocation,
      reason: "Approved",
    });
    expect(withReason).not.toBe(digestHex);
  });

  test("refuses to embed a signature prepared for different bytes", async () => {
    const { invocation, privateKey } = await buildInvocation();
    const digestHex = await digestOf(invocation);
    const signature = await signDigestLikeAKeychain(privateKey, digestHex);

    const otherDigestHex = new Bun.CryptoHasher("sha256")
      .update("a digest for some other document")
      .digest("hex");
    expect(otherDigestHex).not.toBe(digestHex);

    const rejected = await applySignature({
      ...invocation,
      expectedDigestHex: otherDigestHex,
      signature,
      certificateChainComplete: true,
      timestampAuthorities: [],
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(PdfSigningDigestMismatchError);
  });

  test("refuses before any digest exists when a certification forbids changes", async () => {
    const { invocation } = await buildInvocation();

    const locked = await digestOf({
      ...invocation,
      basePdf: await buildCertifiedPdf({ permission: 1 }),
    }).catch((error: unknown) => error);
    expect(locked).toBeInstanceOf(PdfSigningCertifiedDocumentError);

    // Form filling and signing (P=2) and annotating (P=3) both admit an
    // approval signature, so those certifications still prepare a digest.
    for (const permission of [2, 3]) {
      expect(
        await digestOf({
          ...invocation,
          basePdf: await buildCertifiedPdf({ permission }),
        }),
      ).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("takes trusted time from the next authority when one fails", async () => {
    const { invocation, privateKey } = await buildInvocation();
    const digestHex = await digestOf(invocation);
    const signature = await signDigestLikeAKeychain(privateKey, digestHex);
    const working = await createTestTimestampAuthority();

    const applied = await applySignature({
      ...invocation,
      expectedDigestHex: digestHex,
      signature,
      certificateChainComplete: true,
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

  describe("validation data", () => {
    const CRL_URL = "http://crl.example/issuing.crl";

    const signUnderIssuingCa = async ({
      chainComplete,
      crlServed = true,
    }: {
      chainComplete: boolean;
      crlServed?: boolean;
    }) => {
      const root = await createTestCertificate({
        commonName: "Root",
        isCa: true,
      });
      const issuing = await createTestCertificate({
        commonName: "Issuing CA",
        crlUrl: CRL_URL,
        isCa: true,
        issuer: root,
      });
      const leaf = await createTestCertificate({
        caIssuersUrl: "http://pki.example/issuing.cer",
        commonName: "Jane Counsel",
        crlUrl: CRL_URL,
        issuer: issuing,
      });
      const crl = await createTestCrl(issuing);
      const fetched: string[] = [];
      const revocationProvider = createTrackedRevocationProvider(
        async ({ url }) => {
          fetched.push(url);
          return url === CRL_URL && crlServed ? crl : null;
        },
      );

      const invocation = {
        ...(await buildInvocation()).invocation,
        certificate: leaf.der,
        certificateChain: chainComplete
          ? [issuing.der, root.der]
          : [issuing.der],
      };
      const digestHex = await digestOf(invocation);
      const signature = await signDigestLikeAKeychain(
        leaf.privateKey,
        digestHex,
      );

      // LibPDF's own fetching goes through the global `fetch`; nothing may
      // reach it, whatever the certificate's URLs name.
      const globalFetch = globalThis.fetch;
      const globalFetches: string[] = [];
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL) => {
          globalFetches.push(String(input));
          throw new Error("unexpected global fetch");
        },
        { preconnect: globalFetch.preconnect },
      );
      try {
        const applied = await applySignature({
          ...invocation,
          certificateChainComplete: chainComplete,
          expectedDigestHex: digestHex,
          revocationProvider,
          signature,
          timestampAuthorities: [
            {
              authority: await createTestTimestampAuthority(),
              url: "https://tsa.example/",
            },
          ],
        });
        return {
          applied,
          basePdf: invocation.basePdf,
          crl,
          fetched,
          globalFetches,
        };
      } finally {
        globalThis.fetch = globalFetch;
      }
    };

    test("embeds revocation data fetched through the guarded provider for a complete chain", async () => {
      const { applied, basePdf, crl, fetched, globalFetches } =
        await signUnderIssuingCa({ chainComplete: true });

      // Every step was an incremental update: the stored bytes are still the
      // document's prefix, so the signature's byte range is intact.
      expect(
        Buffer.from(applied.bytes.subarray(0, basePdf.byteLength)).equals(
          Buffer.from(basePdf),
        ),
      ).toBe(true);

      expect(applied.level).toBe("B-LT");
      expect(applied.warnings).toEqual([]);
      expect(fetched).toContain(CRL_URL);
      expect(globalFetches).toEqual([]);
      // The CRL lands in the document security store verbatim.
      expect(Buffer.from(applied.bytes).includes(Buffer.from(crl))).toBe(true);
    });

    test("skips validation data for a chain that stops short of a root", async () => {
      const { applied, fetched, globalFetches } = await signUnderIssuingCa({
        chainComplete: false,
      });

      // Revocation data was still gathered for what is there, through the
      // guarded provider; only the level claim stops at trusted time.
      expect(applied.level).toBe("B-T");
      expect(applied.warnings.map(({ code }) => code)).toEqual([
        "CHAIN_INCOMPLETE",
      ]);
      expect(fetched).toContain(CRL_URL);
      expect(globalFetches).toEqual([]);
    });

    test("claims only trusted time when revocation data is unavailable", async () => {
      const { applied } = await signUnderIssuingCa({
        chainComplete: true,
        crlServed: false,
      });

      expect(applied.level).toBe("B-T");
      expect(applied.warnings.map(({ code }) => code)).toEqual([
        "REVOCATION_UNAVAILABLE",
      ]);
    });
  });

  describe("the signature placeholder", () => {
    test("grows with the certificates and the timestamp it must hold", async () => {
      const { invocation } = await buildInvocation();
      const bare = signaturePlaceholderSize({
        certificate: invocation.certificate,
        certificateChain: [],
        timestamped: false,
      });
      const timestamped = signaturePlaceholderSize({
        certificate: invocation.certificate,
        certificateChain: [],
        timestamped: true,
      });
      const longChain = signaturePlaceholderSize({
        certificate: invocation.certificate,
        certificateChain: Array.from({ length: 6 }, () => new Uint8Array(8000)),
        timestamped: true,
      });

      expect(bare).toBeGreaterThanOrEqual(16_384);
      expect(timestamped).toBeGreaterThanOrEqual(32_768);
      expect(longChain).toBeGreaterThan(6 * 8000 + 16_384);
    });

    test("an undersized placeholder is refused in phase 1, before anything is signed", async () => {
      const { invocation } = await buildInvocation();

      const refused = await captureSigningDigest({
        ...invocation,
        placeholderSize: 2048,
      }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(PdfSigningPlaceholderTooSmallError);
    });

    test("the timestamp reserve is checked in phase 1 too", async () => {
      const { invocation } = await buildInvocation();
      // Room for the signature alone: enough without a timestamp coming,
      // too little once one has to fit beside it.
      const withoutTimestamp = signaturePlaceholderSize({
        certificate: invocation.certificate,
        certificateChain: [],
        timestamped: false,
      });

      expect(
        await digestOf({
          ...invocation,
          placeholderSize: withoutTimestamp,
          reserveTimestamp: false,
        }),
      ).toMatch(/^[0-9a-f]{64}$/u);
      const refused = await captureSigningDigest({
        ...invocation,
        placeholderSize: withoutTimestamp,
        reserveTimestamp: true,
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PdfSigningPlaceholderTooSmallError);
    });
  });

  describe("when trusted time cannot be had", () => {
    const signWith = async (
      timestampAuthorities: Parameters<
        typeof applySignature
      >[0]["timestampAuthorities"],
    ) => {
      const { invocation, privateKey } = await buildInvocation();
      const digestHex = await digestOf(invocation);
      const signature = await signDigestLikeAKeychain(privateKey, digestHex);
      return await applySignature({
        ...invocation,
        certificateChainComplete: true,
        expectedDigestHex: digestHex,
        signature,
        timestampAuthorities,
      });
    };

    test("signs without a timestamp and says so when every authority fails", async () => {
      const applied = await signWith([
        {
          authority: {
            timestamp: async () => {
              throw new Error("authority unreachable");
            },
          },
          url: "https://tsa.example/",
        },
      ]);

      expect(applied.level).toBe("B-B");
      expect(applied.timestampAuthorityUrl).toBe(null);
      expect(applied.warnings.map(({ code }) => code)).toEqual([
        "TIMESTAMP_UNAVAILABLE",
      ]);
      expect(await PDF.load(applied.bytes)).toBeDefined();
    });

    test("signs without a timestamp when the token outgrows the reservation", async () => {
      // A well-formed BER value far larger than any reserve: LibPDF accepts
      // it as a token and only fails once it has to fit `/Contents`.
      const oversized = new Uint8Array([
        0x04,
        0x83,
        0x01,
        0x00,
        0x00,
        ...new Uint8Array(65_536),
      ]);
      const applied = await signWith([
        {
          authority: { timestamp: async () => oversized },
          url: "https://tsa.example/",
        },
      ]);

      expect(applied.level).toBe("B-B");
      expect(applied.warnings.map(({ code }) => code)).toEqual([
        "TIMESTAMP_UNAVAILABLE",
      ]);
    });
  });
});
