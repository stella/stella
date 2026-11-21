import { ZipArchive } from "@stll/docx-core/zip";
import { sha256Base64 } from "@stll/sha256/bun";

import { wrapP7m } from "@/api/tests/fixtures/p7m";
import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";

// Synthetic containers built to the published structures, independently of
// the readers. Signature values are placeholders: the readers state signers
// and never verify, so only the certificate and its stated digest matter.

const E_AKTA_NAMESPACE = "https://www.microsec.hu/ds/e-szigno30#";
const XMLDSIG = "http://www.w3.org/2000/09/xmldsig#";
const XADES = "http://uri.etsi.org/01903/v1.3.2#";

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const certificates = new Map<string, Promise<Uint8Array>>();

/** A cached synthetic certificate whose subject common name is `name`. */
const fixtureCertificate = async (name: string) => {
  let der = certificates.get(name);
  if (der === undefined) {
    der = createSelfSignedCertificate({ commonName: name, keyType: "EC" }).then(
      (material) => material.der,
    );
    certificates.set(name, der);
  }
  return await der;
};

type XadesSignatureOptions = {
  id: string;
  signer: string;
  /** Another certificate in the key information, not the signing one. */
  decoy?: string;
  /** A signer name the container states itself, beside the certificate. */
  statedName?: string;
  /** Leaves out every certificate, so only a stated name remains. */
  withoutCertificate?: boolean;
  /** Signed references, `#Object0` by default. */
  references?: readonly { id?: string; uri: string; type?: string }[];
  /** XAdES data object formats, naming a reference by its Id. */
  dataObjectFormats?: readonly {
    reference: string;
    description?: string;
    mimeType: string;
  }[];
  /** Elements placed inside the signature, such as enveloped objects. */
  inner?: string;
};

const referenceXml = ({
  id,
  uri,
  type,
}: {
  id?: string;
  uri: string;
  type?: string;
}) =>
  `<ds:Reference${id === undefined ? "" : ` Id="${id}"`}${
    type === undefined ? "" : ` Type="${type}"`
  } URI="${uri}"><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>AAAA</ds:DigestValue></ds:Reference>`;

/** An XAdES signature element whose signing certificate digest is SHA-256. */
export const xadesSignatureXml = async ({
  id,
  signer,
  decoy,
  statedName,
  withoutCertificate = false,
  references = [{ uri: "#Object0" }],
  dataObjectFormats = [],
  inner = "",
}: XadesSignatureOptions) => {
  const der = await fixtureCertificate(signer);
  const keyInfo = withoutCertificate
    ? ""
    : `<ds:KeyInfo><ds:X509Data>${
        decoy === undefined
          ? ""
          : `<ds:X509Certificate>${base64(await fixtureCertificate(decoy))}</ds:X509Certificate>`
      }<ds:X509Certificate>\n${base64(der).replace(/(.{64})/gu, "$1\n")}\n</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`;
  const profile =
    statedName === undefined
      ? ""
      : `<ds:Object><es:SignatureProfile xmlns:es="${E_AKTA_NAMESPACE}" SIGREF="${id}"><es:SignerName>${escapeXml(statedName)}</es:SignerName><es:Type>signature</es:Type></es:SignatureProfile></ds:Object>`;
  return `<ds:Signature xmlns:ds="${XMLDSIG}" Id="${id}"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>${references.map(referenceXml).join("")}</ds:SignedInfo><ds:SignatureValue>AAAA</ds:SignatureValue>${keyInfo}${profile}<ds:Object><xades:QualifyingProperties xmlns:xades="${XADES}" Target="#${id}"><xades:SignedProperties><xades:SignedSignatureProperties><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${sha256Base64(der)}</ds:DigestValue></xades:CertDigest></xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties>${
    dataObjectFormats.length === 0
      ? ""
      : `<xades:SignedDataObjectProperties>${dataObjectFormats
          .map(
            ({ reference, description, mimeType }) =>
              `<xades:DataObjectFormat ObjectReference="#${reference}">${
                description === undefined
                  ? ""
                  : `<xades:Description>${escapeXml(description)}</xades:Description>`
              }<xades:MimeType>${mimeType}</xades:MimeType></xades:DataObjectFormat>`,
          )
          .join("")}</xades:SignedDataObjectProperties>`
  }</xades:SignedProperties></xades:QualifyingProperties></ds:Object>${inner}</ds:Signature>`;
};

export type EAktaFixtureDocument = {
  title: string;
  extension: string;
  bytes: Uint8Array | string;
  transforms?: readonly ("zip" | "encrypt" | "base64")[];
  /** Signers of this document, in addition to the dossier's frame signers. */
  signers?: readonly string[];
};

const zipOf = async (name: string, bytes: Uint8Array) => {
  const archive = new ZipArchive();
  archive.set(name, bytes);
  return await archive.generate({ compression: "deflate" });
};

/**
 * An e-akta dossier per the Microsec specification v1.5: a profile, the
 * document list, then frame signatures over the whole dossier.
 */
export const makeEAktaFixture = async ({
  documents,
  frameSigners = [],
  namespace = E_AKTA_NAMESPACE,
  category = "electronic dossier",
}: {
  documents: readonly EAktaFixtureDocument[];
  frameSigners?: readonly (string | XadesSignatureOptions)[];
  namespace?: string;
  /** §3.1.2: "electronic acknowledgement" for a delivery receipt. */
  category?: string;
}) => {
  const documentXml = await Promise.all(
    documents.map(
      async (
        { title, extension, bytes, transforms = ["base64"], signers = [] },
        index,
      ) => {
        const raw =
          typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
        const stored = transforms.includes("zip")
          ? await zipOf(title, raw)
          : raw;
        const signatures = await Promise.all(
          signers.map(
            async (signer, position) =>
              await xadesSignatureXml({
                id: `S${index}-${position}`,
                signer,
              }),
          ),
        );
        return `<es:Document><es:DocumentProfile Id="PO${index}" OBJREF="O${index}"><es:Title>${escapeXml(title)}</es:Title><es:CreationDate>2026-01-05T09:00:00Z</es:CreationDate><es:Format><es:MIME-Type type="application" subtype="octet-stream" extension="${extension}"/></es:Format><es:SourceSize sizeValue="${raw.byteLength}" sizeUnit="B"/><es:BaseTransform>${transforms
          .map((algorithm) => `<es:Transform Algorithm="${algorithm}"/>`)
          .join(
            "",
          )}</es:BaseTransform></es:DocumentProfile><ds:Object Id="O${index}">${base64(stored)}</ds:Object>${signatures.join("")}</es:Document>`;
      },
    ),
  );
  const frame = await Promise.all(
    frameSigners.map(
      async (signer, position) =>
        await xadesSignatureXml(
          typeof signer === "string" ? { id: `F${position}`, signer } : signer,
        ),
    ),
  );
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<es:Dossier xmlns:es="${namespace}" xmlns:ds="${XMLDSIG}"><es:DossierProfile Id="PObject0" OBJREF="Object0"><es:Title>Synthetic dossier</es:Title><es:E-category>${category}</es:E-category><es:CreationDate>2026-01-05T09:00:00Z</es:CreationDate></es:DossierProfile><es:Documents Id="Object0">${documentXml.join("")}</es:Documents>${frame.join("")}</es:Dossier>`,
  );
};

type MimePart = { fileName?: string; mimeType: string; bytes: Uint8Array };

const mimeMessage = (parts: readonly MimePart[], boundary: string) => {
  const body = parts
    .map(({ fileName, mimeType, bytes }) =>
      [
        `--${boundary}`,
        `Content-Type: ${mimeType}${fileName ? `; name="${fileName}"` : ""}`,
        "Content-Transfer-Encoding: base64",
        ...(fileName
          ? [`Content-Disposition: attachment; filename="${fileName}"`]
          : []),
        "",
        base64(bytes).replace(/(.{76})/gu, "$1\r\n"),
        "",
      ].join("\r\n"),
    )
    .join("");
  return `${body}--${boundary}--\r\n`;
};

/** A MIME envelope of documents, as ZEPf stores them (NBÚ v3.0, E.1). */
export const makeZepEnvelope = ({
  body,
  attachments = [],
}: {
  body?: string;
  attachments?: readonly MimePart[];
}) => {
  const boundary = "zep-fixture-mixed";
  const parts: MimePart[] = [
    ...(body === undefined
      ? []
      : [
          {
            mimeType: "text/plain; charset=UTF-8",
            bytes: new TextEncoder().encode(body),
          },
        ]),
    ...attachments,
  ];
  return new TextEncoder().encode(
    `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${mimeMessage(parts, boundary)}`,
  );
};

/**
 * A ZEPf container per NBÚ "Formáty zaručených elektronických podpisov" v3.0,
 * Annex E.2: a main directory with a MIME envelope, its detached CMS
 * signature, validation data and any other entries given.
 */
export const makeZepFixture = async ({
  envelope,
  xadesSigner,
  extra = {},
  mainDirectory = true,
}: {
  envelope: Uint8Array;
  /** Adds an XML signature entry for this signer beside the CMS signature. */
  xadesSigner?: string;
  extra?: Readonly<Record<string, Uint8Array | string>>;
  mainDirectory?: boolean;
}) => {
  const zip = new ZipArchive();
  const directory = mainDirectory ? "D20260105090000Z/" : "";
  zip.set(`${directory}M20260105090000Z.eml`, envelope);
  zip.set(
    `${directory}S20260105090000Z.p7s`,
    await wrapP7m(envelope, { detached: true }),
  );
  if (xadesSigner !== undefined) {
    zip.set(
      `${directory}S20260105090000Z1.xml`,
      await xadesSignatureXml({ id: "S1", signer: xadesSigner }),
    );
  }
  zip.set(
    `${directory}Certificate/C20260105090000Z.der`,
    await fixtureCertificate("Example certification authority"),
  );
  for (const [path, bytes] of Object.entries(extra)) {
    zip.set(path, bytes);
  }
  return await zip.generate({ compression: "deflate" });
};

const XADES_ZEP_NAMESPACE =
  "http://www.ditec.sk/ep/signature_formats/xades_zep/v2.0";
const XADES_ZEP_DATA_SIGNATURES_NAMESPACE =
  "http://www.ditec.sk/ep/signature_formats/xades_zep_data_signatures/v2.0";

export type XadesZepFixtureObject = {
  id: string;
  description?: string;
  mimeType: string;
  /** Bytes are stored in base64; a string of XML is embedded as XML. */
  content: Uint8Array | { xml: string };
};

const dataObjectXml = ({ id, content }: XadesZepFixtureObject) =>
  content instanceof Uint8Array
    ? `<ds:Object Encoding="http://www.w3.org/2000/09/xmldsig#base64" Id="${id}">${base64(content)}</ds:Object>`
    : `<ds:Object Id="${id}">${content.xml}</ds:Object>`;

/**
 * A XAdES_ZEP data envelope per the Ditec profile v2.0 §4.2: data objects
 * beside the signature (detached) or inside it (enveloping), each referenced
 * directly or through a manifest and described by a data object format. The
 * composite form wraps the objects with several signatures.
 */
export const makeXadesZepFixture = async ({
  objects,
  signers = ["Example envelope signer"],
  form = "detached",
}: {
  objects: readonly XadesZepFixtureObject[];
  signers?: readonly string[];
  form?: "detached" | "enveloping" | "manifest" | "composite";
}) => {
  const objectXml = objects.map(dataObjectXml).join("");
  const formats = objects.map(({ id, description, mimeType }) => ({
    reference: `Reference-${id}`,
    ...(description === undefined ? {} : { description }),
    mimeType,
  }));
  // As signing clients write it: one manifest per data object.
  const manifest = objects
    .map(
      ({ id }) =>
        `<ds:Object><ds:Manifest Id="Manifest-${id}">${referenceXml({ uri: `#${id}` })}</ds:Manifest></ds:Object>`,
    )
    .join("");
  const signatures = await Promise.all(
    signers.map(
      async (signer, position) =>
        await xadesSignatureXml({
          id: `Signature-${position}`,
          signer,
          references:
            form === "manifest"
              ? objects.map(({ id }) => ({
                  id: `Reference-${id}`,
                  uri: `#Manifest-${id}`,
                  type: "http://www.w3.org/2000/09/xmldsig#Manifest",
                }))
              : objects.map(({ id }) => ({
                  id: `Reference-${id}`,
                  uri: `#${id}`,
                  type: "http://www.w3.org/2000/09/xmldsig#Object",
                })),
          dataObjectFormats: formats,
          inner: {
            detached: "",
            composite: "",
            enveloping: objectXml,
            manifest,
          }[form],
        }),
    ),
  );
  const [root, namespace] =
    form === "composite"
      ? ["xzepds:DataSignatures", XADES_ZEP_DATA_SIGNATURES_NAMESPACE]
      : ["xzep:DataEnvelope", XADES_ZEP_NAMESPACE];
  const prefix = root.split(":", 1)[0];
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns:${prefix}="${namespace}" xmlns:ds="${XMLDSIG}" Id="Envelope">${
      form === "enveloping" ? "" : objectXml
    }${signatures.join("")}</${root}>`,
  );
};
