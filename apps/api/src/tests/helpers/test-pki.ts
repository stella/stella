/**
 * A small certificate hierarchy for signing tests: a root, the CAs it
 * issues, and leaves under them, each optionally naming AIA and CRL URLs.
 *
 * Generated per test, like the self-signed helper, so nothing expires and
 * every field a test depends on is set where the test can see it.
 */

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

const COMMON_NAME_OID = "2.5.4.3";
const BASIC_CONSTRAINTS_OID = "2.5.29.19";
const AUTHORITY_INFO_ACCESS_OID = "1.3.6.1.5.5.7.1.1";
const CRL_DISTRIBUTION_POINTS_OID = "2.5.29.31";
const CA_ISSUERS_OID = "1.3.6.1.5.5.7.48.2";
const OCSP_OID = "1.3.6.1.5.5.7.48.1";
const GENERAL_NAME_URI = 6;

const RSA_KEY = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

export type TestCertificate = {
  certificate: pkijs.Certificate;
  der: Uint8Array;
  privateKey: CryptoKey;
};

type TestCertificateOptions = {
  caIssuersUrl?: string;
  commonName: string;
  crlUrl?: string;
  isCa?: boolean;
  /** Omitted: self-signed. */
  issuer?: TestCertificate;
  ocspUrl?: string;
};

let serial = 1;

const nameOf = (commonName: string) =>
  new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({
        type: COMMON_NAME_OID,
        value: new asn1js.Utf8String({ value: commonName }),
      }),
    ],
  });

const uri = (value: string) =>
  new pkijs.GeneralName({ type: GENERAL_NAME_URI, value });

export const createTestCertificate = async ({
  caIssuersUrl,
  commonName,
  crlUrl,
  isCa = false,
  issuer,
  ocspUrl,
}: TestCertificateOptions): Promise<TestCertificate> => {
  const keys = await crypto.subtle.generateKey(RSA_KEY, true, [
    "sign",
    "verify",
  ]);
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  serial += 1;
  certificate.serialNumber = new asn1js.Integer({ value: serial });
  certificate.subject = nameOf(commonName);
  certificate.issuer = issuer ? issuer.certificate.subject : nameOf(commonName);
  certificate.notBefore.value = new Date(Date.now() - 60_000);
  certificate.notAfter.value = new Date(Date.now() + 86_400_000);

  const extensions = [
    new pkijs.Extension({
      extnID: BASIC_CONSTRAINTS_OID,
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: isCa })
        .toSchema()
        .toBER(false),
    }),
  ];
  const accessDescriptions = [
    ...(caIssuersUrl === undefined
      ? []
      : [
          new pkijs.AccessDescription({
            accessMethod: CA_ISSUERS_OID,
            accessLocation: uri(caIssuersUrl),
          }),
        ]),
    ...(ocspUrl === undefined
      ? []
      : [
          new pkijs.AccessDescription({
            accessMethod: OCSP_OID,
            accessLocation: uri(ocspUrl),
          }),
        ]),
  ];
  if (accessDescriptions.length > 0) {
    extensions.push(
      new pkijs.Extension({
        extnID: AUTHORITY_INFO_ACCESS_OID,
        extnValue: new pkijs.InfoAccess({ accessDescriptions })
          .toSchema()
          .toBER(false),
      }),
    );
  }
  if (crlUrl !== undefined) {
    extensions.push(
      new pkijs.Extension({
        extnID: CRL_DISTRIBUTION_POINTS_OID,
        extnValue: new pkijs.CRLDistributionPoints({
          distributionPoints: [
            new pkijs.DistributionPoint({ distributionPoint: [uri(crlUrl)] }),
          ],
        })
          .toSchema()
          .toBER(false),
      }),
    );
  }
  certificate.extensions = extensions;

  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(issuer?.privateKey ?? keys.privateKey, "SHA-256");

  return {
    certificate,
    der: new Uint8Array(certificate.toSchema().toBER(false)),
    privateKey: keys.privateKey,
  };
};

/** A CRL signed by `issuer` revoking exactly `revoked` (default: none). */
export const createTestCrl = async (
  issuer: TestCertificate,
  revoked: readonly TestCertificate[] = [],
): Promise<Uint8Array> => {
  const crl = new pkijs.CertificateRevocationList();
  crl.version = 1;
  crl.issuer = issuer.certificate.subject;
  if (revoked.length > 0) {
    crl.revokedCertificates = revoked.map(
      ({ certificate }) =>
        new pkijs.RevokedCertificate({
          userCertificate: certificate.serialNumber,
          revocationDate: new pkijs.Time({ type: 0, value: new Date() }),
        }),
    );
  }
  crl.thisUpdate = new pkijs.Time({ type: 0, value: new Date() });
  crl.nextUpdate = new pkijs.Time({
    type: 0,
    value: new Date(Date.now() + 86_400_000),
  });
  await crl.sign(issuer.privateKey, "SHA-256");
  return new Uint8Array(crl.toSchema(true).toBER(false));
};

const ID_PKIX_OCSP_BASIC = "1.3.6.1.5.5.7.48.1.1";

/**
 * A successful OCSP response from `issuer` about `subject`: `good`, or
 * `revoked` as of an hour ago.
 */
export const createTestOcspResponse = async ({
  issuer,
  status,
  subject,
}: {
  issuer: TestCertificate;
  status: "good" | "revoked";
  subject: TestCertificate;
}): Promise<Uint8Array> => {
  const certID = new pkijs.CertID();
  await certID.createForCertificate(subject.certificate, {
    hashAlgorithm: "SHA-1",
    issuerCertificate: issuer.certificate,
  });
  const certStatus =
    status === "good"
      ? new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } })
      : new asn1js.Constructed({
          idBlock: { tagClass: 3, tagNumber: 1 },
          value: [
            new asn1js.GeneralizedTime({
              valueDate: new Date(Date.now() - 3_600_000),
            }),
          ],
        });
  const basic = new pkijs.BasicOCSPResponse({
    tbsResponseData: new pkijs.ResponseData({
      responderID: issuer.certificate.subject,
      producedAt: new Date(),
      responses: [
        new pkijs.SingleResponse({
          certID,
          certStatus,
          thisUpdate: new Date(),
        }),
      ],
    }),
  });
  await basic.sign(issuer.privateKey, "SHA-256");
  return new Uint8Array(
    new pkijs.OCSPResponse({
      responseStatus: new asn1js.Enumerated({ value: 0 }),
      responseBytes: new pkijs.ResponseBytes({
        responseType: ID_PKIX_OCSP_BASIC,
        response: new asn1js.OctetString({
          valueHex: basic.toSchema().toBER(false),
        }),
      }),
    })
      .toSchema()
      .toBER(false),
  );
};
