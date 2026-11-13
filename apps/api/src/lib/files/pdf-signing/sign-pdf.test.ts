import { PDF, PdfBool, PdfNumber, PdfString } from "@libpdf/core";
import type { TimestampAuthority } from "@libpdf/core";
import { beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { archivalTimestampSize } from "@/api/lib/files/pdf-signing/archival-timestamp";
import { createTrackedRevocationProvider } from "@/api/lib/files/pdf-signing/revocation";
import {
  applySignature,
  captureSigningDigest,
  PdfSigningCertificateRevokedError,
  PdfSigningCertifiedDocumentError,
  PdfSigningDigestMismatchError,
  PdfSigningPlaceholderTooSmallError,
  PdfSigningWouldBreakSignaturesError,
  signaturePlaceholderSize,
} from "@/api/lib/files/pdf-signing/sign-pdf";
import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";
import { settled } from "@/api/tests/helpers/settled";
import { createSignedPdf } from "@/api/tests/helpers/signed-pdf";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import {
  createTestCertificate,
  createTestCrl,
  createTestRsaKeyPool,
} from "@/api/tests/helpers/test-pki";
import type { TestCertificate } from "@/api/tests/helpers/test-pki";
import {
  createTestTimestampAuthority,
  createTestTimestampCertificate,
} from "@/api/tests/helpers/timestamp-token";

const testFetchState = createTestFetch();

const keyPool = createTestRsaKeyPool();
const permit = grantThirdPartyOutboundPermit();
beforeEach(() => keyPool.reset());

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

/** Trust in exactly these anchors, nothing shipped. */
const anchorTrust = (anchors: readonly Uint8Array[]) => ({
  anchors,
  pinnedUnits: new Set<string>(),
});

/**
 * An authority that answers the signature's timestamp from `first` and every
 * later request, the archival document timestamp, from `later`.
 */
const scriptedAuthority = (
  first: TimestampAuthority,
  later: TimestampAuthority,
): TimestampAuthority => {
  let calls = 0;
  return {
    timestamp: async (digest, algorithm) => {
      calls += 1;
      return await (calls === 1 ? first : later).timestamp(digest, algorithm);
    },
  };
};

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/**
 * The `/ByteRange` of the last document timestamp; LibPDF writes it after
 * the dictionary's `/Type`.
 */
const docTimeStampByteRange = (bytes: Uint8Array) => {
  const text = latin1(bytes);
  const at = text.lastIndexOf("/DocTimeStamp");
  if (at === -1) {
    return null;
  }
  const dictionary = text.slice(at);
  const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/u.exec(
    dictionary,
  );
  return match === null ? null : match.slice(1).map(Number);
};

const digestOf = async (
  invocation: Parameters<typeof captureSigningDigest>[0],
) => (await settled(captureSigningDigest(invocation))).digestHex;

const buildInvocation = async () => {
  const { der, privateKey } = await createSelfSignedCertificate({
    keyPool,
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
      stamp: null,
      timestampTrust: anchorTrust([]),
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
    const { bytes: signed } = await settled(
      applySignature({
        ...invocation,
        permit,
        expectedDigestHex: digestHex,
        signature,
        certificateChainComplete: true,
        timestampAuthorities: [],
      }),
    );

    // Phase 2 only returns bytes when LibPDF asked it to sign exactly the
    // digest phase 1 published: the two phases agreeing is the invariant.
    expect(Buffer.from(signed.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(signed.byteLength).toBeGreaterThan(invocation.basePdf.byteLength);
    expect(await PDF.load(signed)).toBeDefined();

    // The desktop's exact bytes are what the document carries.
    const document = Buffer.from(signed).toString("latin1");
    const signatureHex = Buffer.from(signature).toHex();
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

    expect(recovered.toHex()).toBe(
      Buffer.concat([
        SHA256_DIGEST_INFO_PREFIX,
        Buffer.from(digestHex, "hex"),
      ]).toHex(),
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

    const otherDigestHex = hashSha256Hex("a digest for some other document");
    expect(otherDigestHex).not.toBe(digestHex);

    const rejected = await settled(
      applySignature({
        ...invocation,
        permit,
        expectedDigestHex: otherDigestHex,
        signature,
        certificateChainComplete: true,
        timestampAuthorities: [],
      }),
    ).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(PdfSigningDigestMismatchError);
  });

  test("refuses before any digest exists when a certification forbids changes", async () => {
    const { invocation } = await buildInvocation();

    const locked = await digestOf({
      ...invocation,
      basePdf: await createSignedPdf({ keyPool, certify: 1 }),
    }).catch((error: unknown) => error);
    expect(locked).toBeInstanceOf(PdfSigningCertifiedDocumentError);

    // Form filling and signing (P=2) and annotating (P=3) both admit an
    // approval signature, so those certifications still prepare a digest.
    for (const permission of [2, 3]) {
      expect(
        await digestOf({
          ...invocation,
          basePdf: await createSignedPdf({ keyPool, certify: permission }),
        }),
      ).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("takes trusted time from the next authority when one fails", async () => {
    const { invocation, privateKey } = await buildInvocation();
    const digestHex = await digestOf(invocation);
    const signature = await signDigestLikeAKeychain(privateKey, digestHex);
    const working = await createTestTimestampAuthority({ keyPool });

    const applied = await settled(
      applySignature({
        ...invocation,
        permit,
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
        timestampTrust: anchorTrust([working.signer.der]),
      }),
    );

    // The timestamp is phase 2's alone: adding it did not change the digest
    // phase 1 published, or the signer above would have refused. The second
    // token is the archival one, fetched down the same list.
    expect(working.issued()).toBe(2);
    expect(applied.level).toBe("B-LTA");
    expect(applied.timestampAuthorityUrl).toBe("https://tsa-up.example/");
    expect(applied.bytes.byteLength).toBeGreaterThan(
      invocation.basePdf.byteLength,
    );
  });

  describe("validation data", () => {
    const CRL_URL = "http://crl.example/issuing.crl";
    const ROOT_CRL_URL = "http://crl.example/root.crl";

    const signUnderIssuingCa = async ({
      archivalAuthority,
      chainComplete,
      crlServed = true,
      extraCrls = {},
      leafRevoked = false,
      now,
      timestampAnchors,
      timestampSigner,
    }: {
      /** Answers every timestamp request after the signature's own. */
      archivalAuthority?: TimestampAuthority;
      chainComplete: boolean;
      crlServed?: boolean;
      /** More CRLs the revocation fetcher serves, by URL. */
      extraCrls?: Record<string, Uint8Array>;
      leafRevoked?: boolean;
      now?: () => number;
      /** Default: pin the timestamp authority's own certificate. */
      timestampAnchors?: (signer: TestCertificate) => Uint8Array[];
      timestampSigner?: TestCertificate;
    }) => {
      const root = await createTestCertificate({
        keyPool,
        commonName: "Root",
        isCa: true,
      });
      const issuing = await createTestCertificate({
        keyPool,
        commonName: "Issuing CA",
        crlUrl: ROOT_CRL_URL,
        isCa: true,
        issuer: root,
      });
      const leaf = await createTestCertificate({
        keyPool,
        caIssuersUrl: "http://pki.example/issuing.cer",
        commonName: "Jane Counsel",
        crlUrl: CRL_URL,
        issuer: issuing,
      });
      const crl = await createTestCrl(issuing, leafRevoked ? [leaf] : []);
      const rootCrl = await createTestCrl(root);
      const fetched: string[] = [];
      const revocationProvider = createTrackedRevocationProvider({
        permit,
        fetcher: async ({ url }) => {
          fetched.push(url);
          if (!crlServed) {
            return null;
          }
          if (url === ROOT_CRL_URL) {
            return rootCrl;
          }
          return url === CRL_URL ? crl : (extraCrls[url] ?? null);
        },
      });

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

      const tsa = await createTestTimestampAuthority(
        timestampSigner === undefined
          ? { keyPool }
          : { signer: timestampSigner },
      );

      // LibPDF's own fetching goes through the global `fetch`; nothing may
      // reach it, whatever the certificate's URLs name.
      const globalFetch = globalThis.fetch;
      const globalFetches: string[] = [];
      testFetchState.set(
        Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            globalFetches.push(
              input instanceof Request ? input.url : input.toString(),
            );
            throw new Error("unexpected global fetch");
          },
          { preconnect: globalFetch.preconnect },
        ),
      );
      try {
        const applied = await settled(
          applySignature({
            ...invocation,
            permit,
            certificateChainComplete: chainComplete,
            expectedDigestHex: digestHex,
            revocationProvider,
            signature,
            timestampAuthorities: [
              {
                authority:
                  archivalAuthority === undefined
                    ? tsa
                    : scriptedAuthority(tsa, archivalAuthority),
                url: "https://tsa.example/",
              },
            ],
            ...(now !== undefined && { now }),
            timestampTrust: anchorTrust(
              (timestampAnchors ?? ((signer) => [signer.der]))(tsa.signer),
            ),
          }),
        );
        return {
          applied,
          basePdf: invocation.basePdf,
          crl,
          fetched,
          globalFetches,
          tsa,
        };
      } finally {
        testFetchState.restore();
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

      expect(applied.level).toBe("B-LTA");
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
      // The issuing CA's CRL cannot be verified without its issuer, so it
      // proves nothing and the CA stays uncovered.
      expect(applied.level).toBe("B-T");
      expect(applied.warnings.map(({ code }) => code)).toEqual([
        "CHAIN_INCOMPLETE",
        "REVOCATION_UNAVAILABLE",
      ]);
      expect(fetched).toContain(CRL_URL);
      expect(globalFetches).toEqual([]);
    });

    test("claims only trusted time when the timestamp's own chain is missing", async () => {
      // The authority's key is issued by a CA the token does not carry and
      // no AIA URL leads to: its time cannot be validated long term.
      const tsaCa = await createTestCertificate({
        keyPool,
        commonName: "Timestamp CA",
        isCa: true,
      });
      const { applied } = await signUnderIssuingCa({
        chainComplete: true,
        timestampSigner: await createTestTimestampCertificate({
          keyPool,
          issuer: tsaCa,
        }),
      });

      expect(applied.level).toBe("B-T");
      expect(applied.warnings.map(({ code }) => code)).toContain(
        "TIMESTAMP_CHAIN_INCOMPLETE",
      );
    });

    test("timestamps with an authority no anchor vouches for, and says so", async () => {
      // A public, non-qualified authority: the level names what the
      // signature carries; trust is the validator's call, reported here.
      const { applied } = await signUnderIssuingCa({
        chainComplete: true,
        timestampAnchors: () => [],
      });

      expect(applied.level).toBe("B-LTA");
      expect(applied.timestampAuthorityUrl).toBe("https://tsa.example/");
      expect(applied.warnings.map(({ code }) => code)).toEqual([
        "TIMESTAMP_UNTRUSTED",
        "ARCHIVE_TIMESTAMP_UNTRUSTED",
      ]);
    });

    test("trusts time whose chain reaches a configured CA", async () => {
      const tsaCa = await createTestCertificate({
        keyPool,
        commonName: "Timestamp CA",
        isCa: true,
      });
      const { applied } = await signUnderIssuingCa({
        chainComplete: true,
        timestampAnchors: () => [tsaCa.der],
        timestampSigner: await createTestTimestampCertificate({
          keyPool,
          issuer: tsaCa,
        }),
      });

      // Trusted time: the chain reached the anchor. Not B-LT only because
      // the authority's certificate has no revocation data to embed.
      expect(applied.level).toBe("B-T");
      expect(applied.warnings.map(({ code }) => code)).toEqual([
        "REVOCATION_UNAVAILABLE",
      ]);
    });

    test("never trusts a timestamp key minted under an ordinary certificate", async () => {
      const root = await createTestCertificate({
        keyPool,
        commonName: "Root",
        isCa: true,
      });
      const ordinary = await createTestCertificate({
        keyPool,
        commonName: "Ordinary holder",
        issuer: root,
      });
      // A timestamping key issued by a certificate that is not a CA: it
      // chains to the configured root by name and signature only.
      const minted = await createTestTimestampCertificate({
        keyPool,
        issuer: ordinary,
      });
      const { applied } = await signUnderIssuingCa({
        chainComplete: true,
        timestampAnchors: () => [root.der],
        timestampSigner: minted,
      });

      // Its chain cannot be completed either, so no validation data.
      expect(applied.level).toBe("B-T");
      expect(applied.warnings.map(({ code }) => code)).toEqual(
        expect.arrayContaining([
          "TIMESTAMP_UNTRUSTED",
          "TIMESTAMP_CHAIN_INCOMPLETE",
        ]),
      );
    });

    describe("the archival document timestamp", () => {
      const ARCHIVE_CRL_URL = "http://crl.example/archive-tsa.crl";

      /** An archival authority issued by its own CA, with a CRL URL. */
      const archivalAuthorityUnderCa = async () => {
        const tsaCa = await createTestCertificate({
          keyPool,
          commonName: "Archive timestamp CA",
          isCa: true,
        });
        const authority = await createTestTimestampAuthority({
          signer: await createTestTimestampCertificate({
            keyPool,
            crlUrl: ARCHIVE_CRL_URL,
            issuer: tsaCa,
          }),
        });
        return { authority, crl: await createTestCrl(tsaCa), tsaCa };
      };

      test("seals the B-LT document with a document timestamp over all of it", async () => {
        const { applied, basePdf, crl, tsa } = await signUnderIssuingCa({
          chainComplete: true,
        });

        expect(applied.level).toBe("B-LTA");
        expect(applied.warnings).toEqual([]);
        expect(tsa.issued()).toBe(2);
        expect(
          Buffer.from(applied.bytes.subarray(0, basePdf.byteLength)).equals(
            Buffer.from(basePdf),
          ),
        ).toBe(true);
        const text = latin1(applied.bytes);
        expect(text).toContain("/SubFilter /ETSI.RFC3161");
        // The timestamp covers the whole document before it, the signature's
        // store included; its authority's data was already in that store,
        // so nothing follows it.
        const range = docTimeStampByteRange(applied.bytes);
        expect(range?.at(0)).toBe(0);
        expect((range?.at(2) ?? 0) + (range?.at(3) ?? 0)).toBe(
          applied.bytes.byteLength,
        );
        expect(
          Buffer.from(applied.bytes).indexOf(Buffer.from(crl)),
        ).toBeLessThan(range?.at(1) ?? 0);
        expect(await PDF.load(applied.bytes)).toBeDefined();
      });

      test("adds the archival authority's validation data in one more store", async () => {
        const archival = await archivalAuthorityUnderCa();
        const { applied, globalFetches } = await signUnderIssuingCa({
          archivalAuthority: archival.authority,
          chainComplete: true,
          extraCrls: { [ARCHIVE_CRL_URL]: archival.crl },
          timestampAnchors: (signer) => [signer.der, archival.tsaCa.der],
        });

        expect(applied.level).toBe("B-LTA");
        expect(applied.warnings).toEqual([]);
        expect(globalFetches).toEqual([]);
        const range = docTimeStampByteRange(applied.bytes);
        const end = (range?.at(2) ?? 0) + (range?.at(3) ?? 0);
        // The authority's CRL lands after the timestamp, in its own update.
        expect(end).toBeLessThan(applied.bytes.byteLength);
        expect(
          Buffer.from(applied.bytes).indexOf(Buffer.from(archival.crl)),
        ).toBeGreaterThan(end);
      });

      test("stays B-LT, timestamp kept, when the archival authority has no revocation data", async () => {
        const archival = await archivalAuthorityUnderCa();
        const { applied } = await signUnderIssuingCa({
          archivalAuthority: archival.authority,
          chainComplete: true,
          timestampAnchors: (signer) => [signer.der, archival.tsaCa.der],
        });

        expect(applied.level).toBe("B-LT");
        expect(applied.warnings.map(({ code }) => code)).toEqual([
          "ARCHIVE_REVOCATION_UNAVAILABLE",
        ]);
        expect(docTimeStampByteRange(applied.bytes)).not.toBeNull();
        expect(await PDF.load(applied.bytes)).toBeDefined();
      });

      test("reaches B-LTA with an archival authority no anchor vouches for, and says so", async () => {
        const archival = await createTestTimestampAuthority({ keyPool });
        const { applied } = await signUnderIssuingCa({
          archivalAuthority: archival,
          chainComplete: true,
        });

        expect(applied.level).toBe("B-LTA");
        expect(applied.warnings.map(({ code }) => code)).toEqual([
          "ARCHIVE_TIMESTAMP_UNTRUSTED",
        ]);
        // Its certificate is new to the store, so one more update after the
        // timestamp carries a store again (its streams may be compressed, so
        // the certificate itself is not searched for).
        const range = docTimeStampByteRange(applied.bytes);
        const end = (range?.at(2) ?? 0) + (range?.at(3) ?? 0);
        expect(end).toBeLessThan(applied.bytes.byteLength);
        expect(latin1(applied.bytes).lastIndexOf("/DSS")).toBeGreaterThan(end);
        expect(archival.issued()).toBe(1);
      });

      test("keeps the B-LT bytes when no authority issues the archival timestamp", async () => {
        const { applied } = await signUnderIssuingCa({
          archivalAuthority: {
            timestamp: async () => {
              throw new Error("authority unreachable");
            },
          },
          chainComplete: true,
        });

        expect(applied.level).toBe("B-LT");
        expect(applied.warnings.map(({ code }) => code)).toEqual([
          "ARCHIVE_TIMESTAMP_UNAVAILABLE",
        ]);
        expect(docTimeStampByteRange(applied.bytes)).toBeNull();
        expect(await PDF.load(applied.bytes)).toBeDefined();
      });

      test("keeps the B-LT bytes when the archival token outgrows its reservation", async () => {
        const { applied } = await signUnderIssuingCa({
          archivalAuthority: await createTestTimestampAuthority({
            keyPool,
            misbehaviour: { padding: 60 },
          }),
          chainComplete: true,
        });

        expect(applied.level).toBe("B-LT");
        expect(applied.warnings.map(({ code }) => code)).toEqual([
          "ARCHIVE_TIMESTAMP_UNAVAILABLE",
        ]);
        expect(docTimeStampByteRange(applied.bytes)).toBeNull();
      });

      test("skips the archival timestamp when phase 2's budget is spent", async () => {
        // The first reading starts the budget; the next one finds it spent.
        const readings = [0, 74_000];
        const { applied, tsa } = await signUnderIssuingCa({
          chainComplete: true,
          now: () => readings.shift() ?? 74_000,
        });

        expect(applied.level).toBe("B-LT");
        expect(applied.warnings.map(({ code }) => code)).toEqual([
          "ARCHIVE_TIMESTAMP_UNAVAILABLE",
        ]);
        expect(tsa.issued()).toBe(1);
      });

      test("reserves room for at least the signature's own token", () => {
        expect(archivalTimestampSize(0)).toBe(16_384);
        expect(archivalTimestampSize(30_000)).toBeGreaterThanOrEqual(34_096);
        expect(archivalTimestampSize(30_000) % 1024).toBe(0);
      });
    });

    test("refuses to embed a signature whose certificate is revoked", async () => {
      const refused = await signUnderIssuingCa({
        chainComplete: true,
        leafRevoked: true,
      }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(PdfSigningCertificateRevokedError);
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

  test("refuses, before any digest exists, to rewrite a PDF that is already signed", async () => {
    const { invocation } = await buildInvocation();
    const signed = await createSignedPdf({ keyPool });
    // A broken cross-reference makes LibPDF repair the file, after which it
    // can only save a full rewrite.
    const text = Buffer.from(signed).toString("latin1");
    const at = text.lastIndexOf("startxref");
    const repaired = new Uint8Array(
      Buffer.from(
        text.slice(0, at) +
          text.slice(at).replace(/startxref\s+\d+/u, "startxref\n999999"),
        "latin1",
      ),
    );

    const refused = await settled(
      captureSigningDigest({
        ...invocation,
        basePdf: repaired,
      }),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PdfSigningWouldBreakSignaturesError);

    // The same repair on an unsigned file breaks nothing, so it signs.
    const created = PDF.create();
    created.addPage({ width: 300, height: 400 });
    const plain = Buffer.from(await created.save()).toString("latin1");
    const plainAt = plain.lastIndexOf("startxref");
    expect(
      await digestOf({
        ...invocation,
        basePdf: new Uint8Array(
          Buffer.from(
            plain.slice(0, plainAt) +
              plain
                .slice(plainAt)
                .replace(/startxref\s+\d+/u, "startxref\n999999"),
            "latin1",
          ),
        ),
      }),
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("prepares the same digest for a PDF that has no file identifier", async () => {
    const { invocation, privateKey } = await buildInvocation();
    // Blank the trailer /ID in place, keeping every byte offset: what many
    // producers outside stella write.
    const text = Buffer.from(invocation.basePdf).toString("latin1");
    const withoutId = text.replace(/\/ID\s*\[[^\]]*\]/u, (id) =>
      " ".repeat(id.length),
    );
    expect(withoutId).not.toBe(text);
    const basePdf = new Uint8Array(Buffer.from(withoutId, "latin1"));
    const noId = { ...invocation, basePdf };

    const digestHex = await digestOf(noId);
    expect(await digestOf(noId)).toBe(digestHex);
    // And phase 2 reproduces it.
    const signature = await signDigestLikeAKeychain(privateKey, digestHex);
    const applied = await settled(
      applySignature({
        ...noId,
        permit,
        certificateChainComplete: true,
        expectedDigestHex: digestHex,
        signature,
        timestampAuthorities: [],
      }),
    );
    expect(applied.level).toBe("B-B");
  });

  describe("a form that leaves its appearances to the viewer", () => {
    const FIELD_VALUE = "Jana Nováková";
    const DRAWN_TOTAL = "100";
    const CURRENT_TOTAL = "120";

    /**
     * What a producer relying on `/NeedAppearances true` writes: field
     * values, and no appearance for the text field.
     */
    const buildNeedAppearancesForm = async () => {
      const created = PDF.create();
      const page = created.addPage({ width: 300, height: 400 });
      const form = created.getOrCreateForm();
      const name = form.createTextField("name");
      page.drawField(name, { x: 20, y: 340, width: 200, height: 24 });
      name.setValue(FIELD_VALUE);
      const agree = form.createCheckbox("agree");
      page.drawField(agree, { x: 20, y: 300, width: 16, height: 16 });
      agree.check();
      for (const widget of name.getWidgets()) {
        widget.dict.delete("AP");
      }
      // A read-only field whose appearance shows an older value: a viewer
      // honouring the flag draws the current one.
      const total = form.createTextField("total");
      page.drawField(total, { x: 20, y: 260, width: 200, height: 24 });
      total.setValue(DRAWN_TOTAL);
      total.acroField().set("Ff", PdfNumber.of(1));
      total.acroField().set("V", PdfString.fromString(CURRENT_TOTAL));
      form.acroForm().getDict().set("NeedAppearances", PdfBool.of(true));
      // LibPDF sets SigFlags on adding a field, as a form with an empty
      // signature field carries them: that alone is no signature.
      expect(form.properties.hasSignatures).toBe(true);
      return await created.save();
    };

    const revisionCount = (bytes: Uint8Array) =>
      Buffer.from(bytes).toString("latin1").split("%%EOF").length - 1;

    const signBoth = async (basePdf: Uint8Array) => {
      const { invocation, privateKey } = await buildInvocation();
      const withBase = { ...invocation, basePdf };
      const digestHex = await digestOf(withBase);
      // Phase 1 run twice, and phase 2 accepting the digest, is the
      // byte-identity check: the digest covers every prepared byte.
      expect(await digestOf(withBase)).toBe(digestHex);
      return await settled(
        applySignature({
          ...withBase,
          permit,
          certificateChainComplete: true,
          expectedDigestHex: digestHex,
          signature: await signDigestLikeAKeychain(privateKey, digestHex),
          timestampAuthorities: [],
        }),
      );
    };

    test("draws the fields and clears the flag in a revision before the signature", async () => {
      const basePdf = await buildNeedAppearancesForm();
      expect(
        (await PDF.load(basePdf)).getForm()?.properties.needAppearances,
      ).toBe(true);

      const applied = await signBoth(basePdf);

      expect(
        Buffer.from(applied.bytes.subarray(0, basePdf.byteLength)),
      ).toEqual(Buffer.from(basePdf));
      // One revision for the appearances, one for the signature.
      expect(revisionCount(applied.bytes)).toBe(revisionCount(basePdf) + 2);
      const form = (await PDF.load(applied.bytes)).getForm();
      expect(form?.properties.needAppearances).toBe(false);
      expect(form?.getTextField("name")?.getValue()).toBe(FIELD_VALUE);
      expect(form?.getCheckbox("agree")?.isChecked()).toBe(true);
      expect(
        form
          ?.getTextField("name")
          ?.getWidgets()
          .every((widget) => widget.hasNormalAppearance()),
      ).toBe(true);
      const total = form?.getTextField("total");
      expect(total?.isReadOnly()).toBe(true);
      expect(
        Buffer.from(
          total?.getWidgets().at(0)?.getNormalAppearance()?.getDecodedData() ??
            [],
        ).toString("latin1"),
      ).toContain(`(${CURRENT_TOTAL})`);
      expect(applied.warnings.map(({ code }) => code)).toEqual([]);
    });

    test("leaves an already signed form as it is", async () => {
      const signed = await PDF.load(await createSignedPdf({ keyPool }));
      signed
        .getOrCreateForm()
        .acroForm()
        .getDict()
        .set("NeedAppearances", PdfBool.of(true));
      const basePdf = await signed.save({ incremental: true });

      const applied = await signBoth(basePdf);

      expect(
        Buffer.from(applied.bytes.subarray(0, basePdf.byteLength)),
      ).toEqual(Buffer.from(basePdf));
      expect(revisionCount(applied.bytes)).toBe(revisionCount(basePdf) + 1);
      expect(
        (await PDF.load(applied.bytes)).getForm()?.properties.needAppearances,
      ).toBe(true);
      expect(applied.warnings.map(({ code }) => code)).toEqual([
        "FIELD_APPEARANCES_LEFT_TO_VIEWER",
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

      const refused = await settled(
        captureSigningDigest({
          ...invocation,
          placeholderSize: 2048,
        }),
      ).catch((error: unknown) => error);

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
      const refused = await settled(
        captureSigningDigest({
          ...invocation,
          placeholderSize: withoutTimestamp,
          reserveTimestamp: true,
        }),
      ).catch((error: unknown) => error);
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
      return await settled(
        applySignature({
          ...invocation,
          permit,
          certificateChainComplete: true,
          expectedDigestHex: digestHex,
          signature,
          timestampAuthorities,
        }),
      );
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

    test("never counts a token about another signature as trusted time", async () => {
      const applied = await signWith([
        {
          authority: await createTestTimestampAuthority({
            keyPool,
            misbehaviour: { imprint: new Uint8Array(32).fill(3) },
          }),
          url: "https://tsa.example/",
        },
      ]);

      expect(applied.level).toBe("B-B");
      expect(applied.timestampAuthorityUrl).toBe(null);
      expect(applied.warnings.map(({ code }) => code)).toEqual([
        "TIMESTAMP_UNAVAILABLE",
      ]);
    });

    test("signs without a timestamp when the token outgrows the reservation", async () => {
      // A valid token, but one carrying far more certificates than the
      // reservation phase 1 made room for.
      const applied = await signWith([
        {
          authority: await createTestTimestampAuthority({
            keyPool,
            misbehaviour: { padding: 60 },
          }),
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
