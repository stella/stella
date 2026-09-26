/**
 * An in-process RFC 3161 timestamp authority for signing tests.
 *
 * Issues real TimeStampTokens (CMS SignedData over a TSTInfo) signed by a
 * test certificate, and can be told to misbehave in exactly one way at a
 * time (wrong imprint, missing nonce, stale time, a key not meant for
 * timestamping) so each check has a token that differs only there.
 */

import type { DigestAlgorithm, TimestampAuthority } from "@libpdf/core";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

import type { PkiFetcher } from "@/api/lib/pdf-signing/pki-fetch";
import { createTestCertificate } from "@/api/tests/helpers/test-pki";
import type { TestCertificate } from "@/api/tests/helpers/test-pki";

const ID_CT_TST_INFO = "1.2.840.113549.1.9.16.1.4";
const ID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const ID_SHA256 = "2.16.840.1.101.3.4.2.1";
const ID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const ID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
export const TIME_STAMPING_USAGE = "1.3.6.1.5.5.7.3.8";
/** An arbitrary policy arc; verifiers only need one to be present. */
const TEST_POLICY_OID = "1.3.6.1.4.1.99999.1";

export type TestTimestampMisbehaviour = {
  /** Replace the imprint the token claims to be about. */
  imprint?: Uint8Array;
  /** Time the token claims; default now. */
  genTime?: Date;
  /** Leave the request's nonce out of the token. */
  dropNonce?: boolean;
  /** Carry the signer's certificate this many extra times: a bulky token. */
  padding?: number;
};

/** A timestamping certificate: self-signed unless `issuer` is given. */
export const createTestTimestampCertificate = async ({
  extendedKeyUsages = [TIME_STAMPING_USAGE],
  issuer,
}: {
  extendedKeyUsages?: string[];
  issuer?: TestCertificate;
} = {}) =>
  await createTestCertificate({
    commonName: "stella test timestamp authority",
    extendedKeyUsages,
    ...(issuer !== undefined && { issuer }),
  });

export const issueTestTimestampToken = async ({
  digest,
  misbehaviour = {},
  nonce,
  serial,
  signer,
}: {
  digest: Uint8Array;
  misbehaviour?: TestTimestampMisbehaviour;
  nonce?: asn1js.Integer;
  serial: number;
  signer: TestCertificate;
}): Promise<Uint8Array> => {
  const tstInfo = new pkijs.TSTInfo({
    version: 1,
    policy: TEST_POLICY_OID,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: ID_SHA256 }),
      hashedMessage: new asn1js.OctetString({
        valueHex: new Uint8Array(misbehaviour.imprint ?? digest).buffer,
      }),
    }),
    serialNumber: new asn1js.Integer({ value: serial }),
    genTime: misbehaviour.genTime ?? new Date(),
    ...(nonce !== undefined && !misbehaviour.dropNonce && { nonce }),
  });

  const signedData = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: ID_CT_TST_INFO,
      eContent: new asn1js.OctetString({
        valueHex: tstInfo.toSchema().toBER(false),
      }),
    }),
    certificates: Array.from(
      { length: 1 + (misbehaviour.padding ?? 0) },
      () => signer.certificate,
    ),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: signer.certificate.issuer,
          serialNumber: signer.certificate.serialNumber,
        }),
      }),
    ],
  });
  // pkijs re-encodes an eContent handed to its constructor as a constructed
  // OCTET STRING; authorities send the primitive DER form, so set that.
  const content = tstInfo.toSchema().toBER(false);
  signedData.encapContentInfo.eContent = new asn1js.OctetString({
    valueHex: content,
  });
  // Signed attributes, as every real authority sends: the signature covers
  // them and they bind the content by its digest.
  const signerInfo = signedData.signerInfos.at(0);
  if (signerInfo !== undefined) {
    signerInfo.signedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 0,
      attributes: [
        new pkijs.Attribute({
          type: ID_CONTENT_TYPE,
          values: [new asn1js.ObjectIdentifier({ value: ID_CT_TST_INFO })],
        }),
        new pkijs.Attribute({
          type: ID_MESSAGE_DIGEST,
          values: [
            new asn1js.OctetString({
              valueHex: await crypto.subtle.digest("SHA-256", content),
            }),
          ],
        }),
      ],
    });
  }
  await signedData.sign(signer.privateKey, 0, "SHA-256");

  return new Uint8Array(
    new pkijs.ContentInfo({
      contentType: ID_SIGNED_DATA,
      content: signedData.toSchema(true),
    })
      .toSchema()
      .toBER(false),
  );
};

export type TestTimestampAuthority = TimestampAuthority & {
  /** How many tokens this authority issued. */
  issued: () => number;
  signer: TestCertificate;
};

/** A `TimestampAuthority` answering in process, with no nonce. */
export const createTestTimestampAuthority = async ({
  misbehaviour,
  signer,
}: {
  misbehaviour?: TestTimestampMisbehaviour;
  signer?: TestCertificate;
} = {}): Promise<TestTimestampAuthority> => {
  const tsa = signer ?? (await createTestTimestampCertificate());
  let serial = 0;
  return {
    issued: () => serial,
    signer: tsa,
    timestamp: async (digest: Uint8Array, _algorithm: DigestAlgorithm) => {
      serial += 1;
      return await issueTestTimestampToken({
        digest,
        misbehaviour,
        serial,
        signer: tsa,
      });
    },
  };
};

/**
 * An RFC 3161 responder behind a fake PKI fetcher: parses the request and
 * answers with a TimeStampResp, echoing its nonce unless told not to.
 */
export const createTestTimestampResponder = async ({
  misbehaviour,
}: { misbehaviour?: TestTimestampMisbehaviour } = {}) => {
  const signer = await createTestTimestampCertificate();
  const requests: { contentType?: string; url: string }[] = [];
  let serial = 0;
  const fetcher: PkiFetcher = async ({ body, contentType, url }) => {
    requests.push({ contentType, url });
    if (body === undefined) {
      return null;
    }
    const request = pkijs.TimeStampReq.fromBER(new Uint8Array(body));
    serial += 1;
    const token = await issueTestTimestampToken({
      digest: new Uint8Array(
        request.messageImprint.hashedMessage.valueBlock.valueHexView,
      ),
      misbehaviour,
      nonce: request.nonce,
      serial,
      signer,
    });
    return new Uint8Array(
      new pkijs.TimeStampResp({
        status: new pkijs.PKIStatusInfo({ status: 0 }),
        timeStampToken: pkijs.ContentInfo.fromBER(token),
      })
        .toSchema()
        .toBER(false),
    );
  };
  return { fetcher, requests };
};
