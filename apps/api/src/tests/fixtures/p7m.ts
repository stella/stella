import * as asn1js from "asn1js";
import { panic } from "better-result";
import * as pkijs from "pkijs";

import { CMS_DATA_OID, CMS_SIGNED_DATA_OID } from "@/api/lib/files/cms-signed-data";
import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";

const SUBJECT_KEY_IDENTIFIER_OID = "2.5.29.14";
const SIGNATURE_SERIAL_NUMBER = 1;
const KEY_IDENTIFIER = new Uint8Array([0x0a, 0x0b, 0xfe, 0xff]);
const FIXTURE_SIGNER_NAMES = ["Example first signer", "Example second signer"] as const;

const createSignerMaterial = async (commonName: string) => {
  const material = await createSelfSignedCertificate({ commonName });
  const certificate = pkijs.Certificate.fromBER(material.der);
  certificate.serialNumber = new asn1js.Integer({ value: SIGNATURE_SERIAL_NUMBER });
  certificate.extensions = [
    ...(certificate.extensions ?? []),
    new pkijs.Extension({
      extnID: SUBJECT_KEY_IDENTIFIER_OID,
      extnValue: new asn1js.OctetString({ valueHex: KEY_IDENTIFIER }).toBER(),
    }),
  ];
  await certificate.sign(material.privateKey, "SHA-256");
  return { certificate, privateKey: material.privateKey };
};

let signerMaterials: Promise<Awaited<ReturnType<typeof createSignerMaterial>>[]> | undefined;

type WrapP7mOptions = {
  signers?: ("issuer" | "ski")[];
  contentType?: string;
  detached?: boolean;
  constructed?: boolean;
  omitSignerCertificates?: boolean;
};

export const wrapP7m = async (
  bytes: Uint8Array,
  {
    signers = ["issuer"],
    contentType = CMS_DATA_OID,
    detached = false,
    constructed = false,
    omitSignerCertificates = false,
  }: WrapP7mOptions = {},
) => {
  const materials = await (signerMaterials ??= Promise.all(
    FIXTURE_SIGNER_NAMES.map(createSignerMaterial),
  ));
  const selected = materials.slice(0, signers.length);
  const signedData = new pkijs.SignedData({
    version: signers.includes("ski") ? 3 : 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: contentType }),
    certificates: selected.map(({ certificate }) => certificate),
    signerInfos: selected.map(({ certificate }, index) =>
      signers.at(index) === "ski"
        ? new pkijs.SignerInfo({
            version: 3,
            sid: new asn1js.Primitive({
              idBlock: { tagClass: 3, tagNumber: 0 },
              valueHex: KEY_IDENTIFIER,
            }),
          })
        : new pkijs.SignerInfo({
            version: 1,
            sid: new pkijs.IssuerAndSerialNumber({
              issuer: certificate.issuer,
              serialNumber: certificate.serialNumber,
            }),
          }),
    ),
  });
  if (bytes.byteLength === 0) {
    signedData.encapContentInfo.eContent = new asn1js.OctetString();
  }
  await Promise.all(selected.map(({ privateKey }, index) =>
    signedData.sign(privateKey, index, "SHA-256", bytes.slice().buffer),
  ));
  if (omitSignerCertificates) {
    // The second certificate has the same serial number and a different issuer.
    signedData.certificates = materials.slice(1).map(({ certificate }) => certificate);
  }
  const schema = signedData.toSchema(true);
  if (!detached) {
    const encapsulatedContent = schema.valueBlock.value.at(2);
    if (!(encapsulatedContent instanceof asn1js.Sequence)) {
      return panic("Expected a CMS EncapsulatedContentInfo sequence");
    }
    const eContent = constructed
      ? new asn1js.OctetString({
          idBlock: { isConstructed: true },
          isConstructed: true,
          lenBlock: { isIndefiniteForm: true },
          value: [
            new asn1js.OctetString({ valueHex: bytes.subarray(0, 2) }),
            new asn1js.OctetString({
              idBlock: { isConstructed: true },
              isConstructed: true,
              value: [
                new asn1js.OctetString({ valueHex: bytes.subarray(2, 4) }),
                new asn1js.OctetString({ valueHex: bytes.subarray(4) }),
              ],
            }),
          ],
        })
      : new asn1js.OctetString({ valueHex: bytes });
    // PKI.js omits an empty OCTET STRING on serialization.
    encapsulatedContent.valueBlock.value.push(new asn1js.Constructed({
      idBlock: { tagClass: 3, tagNumber: 0 },
      value: [eContent],
    }));
  }
  return new Uint8Array(
    new pkijs.ContentInfo({ contentType: CMS_SIGNED_DATA_OID, content: schema })
      .toSchema()
      .toBER(false),
  );
};
