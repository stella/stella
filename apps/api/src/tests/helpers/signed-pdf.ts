/**
 * Digitally signed PDF fixtures, and the check that a signature still covers
 * the bytes it was made over.
 *
 * The certificate is minted per run by the shared test PKI rather than
 * checked in: these tests care whether the signed byte ranges survive, never
 * whether the signer is trusted, and a checked-in key would be one more
 * secret-shaped file in the tree.
 */

import {
  CryptoKeySigner,
  PDF,
  PdfArray,
  PdfDict,
  PdfName,
  PdfNumber,
  PdfRef,
  PdfString,
  rgb,
} from "@libpdf/core";
import { panic } from "better-result";

import { createTestCertificate } from "@/api/tests/helpers/test-pki";

const concat = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** A signer over a per-run test certificate; see `test-pki.ts`. */
const createSigner = async (): Promise<CryptoKeySigner> => {
  const { der, privateKey } = await createTestCertificate({
    commonName: "stella signed pdf fixture",
  });
  return new CryptoKeySigner(privateKey, der, "RSA", "RSASSA-PKCS1-v1_5");
};

/**
 * A later revision appended after signing that hides the signature from the
 * current document view while the signed bytes stay earlier in the file.
 *
 * - `drop-sig-flags`: removes the AcroForm SigFlags, as some producers never
 *   write them.
 * - `inherit-signature-value`: moves the field's /V onto a new parent field,
 *   so the terminal field only inherits it.
 * - `remove-signature-field`: drops the field and its widget entirely.
 */
export type SignatureHidingRevision =
  | "drop-sig-flags"
  | "inherit-signature-value"
  | "remove-signature-field";

type SignedPdfOptions = {
  /**
   * Certify the first signature with DocMDP at this permission level; `null`
   * leaves `/P` out, which readers take as 2. Out-of-range numbers are
   * written as given.
   */
  certify?: number | null;
  hidingRevision?: SignatureHidingRevision;
  /** How many signatures to apply, each in its own revision. */
  signatures?: number;
  /** Write cross-reference streams instead of classic xref tables. */
  xrefStream?: boolean;
};

const drawScan = (pdf: PDF) => {
  pdf.addPage({ width: 600, height: 800 }).drawRectangle({
    x: 40,
    y: 680,
    width: 300,
    height: 40,
    color: rgb(0.8, 0.8, 0.8),
  });
};

/**
 * Turns the next signature dictionary libpdf registers into a certification
 * signature: a DocMDP /Reference transform on the signature, and the catalog's
 * /Perms pointing at it, written in the same revision as the signature.
 */
const certifyNextSignature = (pdf: PDF, level: number | null) => {
  const { registry } = pdf.context;
  const register = registry.register.bind(registry);
  registry.register = (object) => {
    if (
      !(object instanceof PdfDict) ||
      object.getName("Type")?.value !== "Sig"
    ) {
      return register(object);
    }
    registry.register = register;
    object.set(
      "Reference",
      PdfArray.of(
        PdfDict.of({
          Type: PdfName.of("SigRef"),
          TransformMethod: PdfName.of("DocMDP"),
          TransformParams: PdfDict.of({
            Type: PdfName.of("TransformParams"),
            ...(level !== null && { P: PdfNumber.of(level) }),
            V: PdfName.of("1.2"),
          }),
        }),
      ),
    );
    const ref = register(object);
    pdf.getCatalog().set("Perms", PdfDict.of({ DocMDP: ref }));
    return ref;
  };
};

const appendHidingRevision = async (
  bytes: Uint8Array,
  revision: SignatureHidingRevision,
): Promise<Uint8Array> => {
  const pdf = await PDF.load(bytes);
  const resolve = (ref: PdfRef) => pdf.getObject(ref);
  const acroForm = pdf.getCatalog().getDict("AcroForm", resolve);
  const fieldRef = acroForm?.getArray("Fields", resolve)?.at(0);
  const field = fieldRef instanceof PdfRef ? fieldRef : null;
  const fieldDict = field === null ? null : pdf.getObject(field);
  if (!acroForm || field === null || !(fieldDict instanceof PdfDict)) {
    panic("signed fixture has no signature field");
  }
  acroForm.delete("SigFlags");
  switch (revision) {
    case "drop-sig-flags":
      break;
    case "inherit-signature-value": {
      const value = fieldDict.getRef("V");
      if (value === undefined) {
        panic("signed fixture field has no value");
      }
      const parent = pdf.register(
        PdfDict.of({
          FT: PdfName.of("Sig"),
          T: PdfString.fromString("Signatures"),
          V: value,
          Kids: PdfArray.of(field),
        }),
      );
      fieldDict.delete("V");
      fieldDict.delete("FT");
      fieldDict.set("Parent", parent);
      acroForm.set("Fields", PdfArray.of(parent));
      break;
    }
    case "remove-signature-field": {
      acroForm.set("Fields", PdfArray.of());
      const page = pdf.getPages().at(0);
      page?.dict.set("Annots", PdfArray.of());
      break;
    }
    default:
      revision satisfies never;
  }
  return await pdf.save({ incremental: true });
};

/**
 * A one-page, image-like PDF (no native text) carrying real signatures made by
 * libpdf over a per-run certificate, optionally certified, and optionally with
 * a later revision that hides the signature from the current form view.
 */
export const createSignedPdf = async ({
  certify,
  hidingRevision,
  signatures = 1,
  xrefStream = false,
}: SignedPdfOptions = {}): Promise<Uint8Array> => {
  const unsigned = PDF.create();
  drawScan(unsigned);
  let bytes = await unsigned.save({ useXRefStream: xrefStream });
  const signer = await createSigner();
  for (let index = 0; index < signatures; index += 1) {
    const pdf = await PDF.load(bytes);
    if (index === 0 && certify !== undefined) {
      certifyNextSignature(pdf, certify);
    }
    ({ bytes } = await pdf.sign({
      signer,
      fieldName: `Signature${index + 1}`,
      reason: "fixture",
    }));
  }
  return hidingRevision === undefined
    ? bytes
    : await appendHidingRevision(bytes, hidingRevision);
};

/** A one-page PDF encrypted with an owner password, and a user one if given. */
export const createEncryptedPdf = async (
  userPassword?: string,
): Promise<Uint8Array> => {
  const pdf = PDF.create();
  drawScan(pdf);
  pdf.setProtection({
    ownerPassword: "fixture-owner",
    ...(userPassword !== undefined && { userPassword }),
  });
  return await pdf.save();
};

const BYTE_RANGE = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/gu;
// messageDigest attribute: its OID, then SET { OCTET STRING (32 bytes) }.
const MESSAGE_DIGEST_PREFIX = Uint8Array.of(
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x09,
  0x04,
  0x31,
  0x22,
  0x04,
  0x20,
);

const indexOf = (haystack: Uint8Array, needle: Uint8Array): number => {
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((byte, offset) => haystack[start + offset] === byte)) {
      return start;
    }
  }
  return -1;
};

const hexToBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));

export type SignatureIntegrity = {
  /** End offset of the revision the signature covers. */
  coveredLength: number;
  /** SHA-256 over the ByteRange equals the digest the signer signed. */
  digestMatches: boolean;
};

/**
 * Reads every signature's ByteRange out of the raw file and recomputes the
 * digest it covers against the CMS messageDigest attribute. A rewrite that
 * moved, re-encoded or dropped any covered byte fails here, which is exactly
 * what a PDF reader reports as a broken signature.
 */
export const readSignatureIntegrity = async (
  bytes: Uint8Array,
): Promise<SignatureIntegrity[]> => {
  const text = new TextDecoder("latin1").decode(bytes);
  return await Promise.all(
    Array.from(text.matchAll(BYTE_RANGE), async (match) => {
      const [start = 0, firstLength = 0, second = 0, secondLength = 0] = match
        .slice(1, 5)
        .map(Number);
      const covered = concat([
        bytes.subarray(start, start + firstLength),
        bytes.subarray(second, second + secondLength),
      ]);
      const contentsHex = text
        .slice(start + firstLength, second)
        .replace(/[<>\s]/gu, "");
      const cms = hexToBytes(contentsHex);
      const at = indexOf(cms, MESSAGE_DIGEST_PREFIX);
      const signedDigest =
        at === -1
          ? new Uint8Array()
          : cms.subarray(
              at + MESSAGE_DIGEST_PREFIX.length,
              at + MESSAGE_DIGEST_PREFIX.length + 32,
            );
      const actualDigest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", covered),
      );
      return {
        coveredLength: second + secondLength,
        digestMatches:
          signedDigest.length === 32 &&
          actualDigest.every((byte, index) => byte === signedDigest[index]),
      };
    }),
  );
};
