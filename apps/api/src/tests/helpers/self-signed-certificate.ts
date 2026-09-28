/**
 * Self-signed X.509 certificates for signing tests.
 *
 * Generated per test rather than checked in: a fixture certificate would
 * expire, and the validity-window and key-usage rejections need certificates
 * that differ on exactly those fields.
 */

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

export const KEY_USAGE = {
  digitalSignature: 0x80,
  nonRepudiation: 0x40,
  keyEncipherment: 0x20,
} as const;

const KEY_USAGE_OID = "2.5.29.15";
const COMMON_NAME_OID = "2.5.4.3";

export type SelfSignedCertificateOptions = {
  commonName?: string;
  /** Bitmask of {@link KEY_USAGE}, or "none" to omit the extension. */
  keyUsage?: number | "none";
  keyType?: "RSA" | "EC";
  notAfter?: Date;
  notBefore?: Date;
};

export type SelfSignedCertificate = {
  der: Uint8Array;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
};

const algorithmFor = (keyType: "RSA" | "EC") =>
  keyType === "RSA"
    ? ({
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      } as const)
    : ({ name: "ECDSA", namedCurve: "P-256" } as const);

export const createSelfSignedCertificate = async ({
  commonName = "stella signing test",
  keyUsage = KEY_USAGE.digitalSignature,
  keyType = "RSA",
  notBefore = new Date(Date.now() - 60_000),
  notAfter = new Date(Date.now() + 3_600_000),
}: SelfSignedCertificateOptions = {}): Promise<SelfSignedCertificate> => {
  const keys = await crypto.subtle.generateKey(algorithmFor(keyType), true, [
    "sign",
    "verify",
  ]);

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: Date.now() });
  const name = new pkijs.AttributeTypeAndValue({
    type: COMMON_NAME_OID,
    value: new asn1js.Utf8String({ value: commonName }),
  });
  certificate.issuer.typesAndValues.push(name);
  certificate.subject.typesAndValues.push(name);
  certificate.notBefore.value = notBefore;
  certificate.notAfter.value = notAfter;

  if (keyUsage !== "none") {
    // RFC 5280 KeyUsage is a BIT STRING whose leading byte carries
    // digitalSignature (bit 0) through keyEncipherment (bit 2).
    const bits = new asn1js.BitString({
      unusedBits: 5,
      valueHex: new Uint8Array([keyUsage]).buffer,
    });
    certificate.extensions = [
      new pkijs.Extension({
        extnID: KEY_USAGE_OID,
        critical: true,
        extnValue: bits.toBER(false),
      }),
    ];
  }

  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(keys.privateKey, "SHA-256");

  return {
    der: new Uint8Array(certificate.toSchema().toBER(false)),
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  };
};
