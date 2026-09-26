/**
 * An in-process RFC 3161 timestamp authority for signing tests.
 *
 * Issues real TimeStampTokens (CMS SignedData over a TSTInfo) signed by a
 * self-signed test certificate, so a signature can be embedded with trusted
 * time without a network round trip.
 */

import type { DigestAlgorithm, TimestampAuthority } from "@libpdf/core";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";

const ID_CT_TST_INFO = "1.2.840.113549.1.9.16.1.4";
const ID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const ID_SHA256 = "2.16.840.1.101.3.4.2.1";
/** An arbitrary policy arc; verifiers only need one to be present. */
const TEST_POLICY_OID = "1.3.6.1.4.1.99999.1";

export type TestTimestampAuthority = TimestampAuthority & {
  /** How many tokens this authority issued. */
  issued: () => number;
};

export const createTestTimestampAuthority =
  async (): Promise<TestTimestampAuthority> => {
    const { der, privateKey } = await createSelfSignedCertificate({
      commonName: "stella test timestamp authority",
    });
    const certificate = pkijs.Certificate.fromBER(new Uint8Array(der));
    let serial = 0;

    return {
      issued: () => serial,
      timestamp: async (digest: Uint8Array, _algorithm: DigestAlgorithm) => {
        serial += 1;
        const tstInfo = new pkijs.TSTInfo({
          version: 1,
          policy: TEST_POLICY_OID,
          messageImprint: new pkijs.MessageImprint({
            hashAlgorithm: new pkijs.AlgorithmIdentifier({
              algorithmId: ID_SHA256,
            }),
            hashedMessage: new asn1js.OctetString({
              valueHex: new Uint8Array(digest).buffer,
            }),
          }),
          serialNumber: new asn1js.Integer({ value: serial }),
          genTime: new Date(),
        });

        const signedData = new pkijs.SignedData({
          version: 3,
          encapContentInfo: new pkijs.EncapsulatedContentInfo({
            eContentType: ID_CT_TST_INFO,
            eContent: new asn1js.OctetString({
              valueHex: tstInfo.toSchema().toBER(false),
            }),
          }),
          certificates: [certificate],
          signerInfos: [
            new pkijs.SignerInfo({
              version: 1,
              sid: new pkijs.IssuerAndSerialNumber({
                issuer: certificate.issuer,
                serialNumber: certificate.serialNumber,
              }),
            }),
          ],
        });
        await signedData.sign(privateKey, 0, "SHA-256");

        const contentInfo = new pkijs.ContentInfo({
          contentType: ID_SIGNED_DATA,
          content: signedData.toSchema(true),
        });
        return new Uint8Array(contentInfo.toSchema().toBER(false));
      },
    };
  };
