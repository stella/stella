/**
 * Long-term validation data (PAdES B-LT), gathered and embedded here rather
 * than by LibPDF.
 *
 * LibPDF's own gatherer rebuilds the signer's chain from the leaf's AIA URL
 * with the global `fetch` even when the chain it was given is complete, and
 * it offers no way to substitute the fetcher. The chain is already complete
 * and verified by phase 1, so all that is left is revocation data, which is
 * fetched through the guarded PKI fetcher and written as a Document Security
 * Store in one more incremental update (ISO 32000-2 12.8.4.3).
 */

import { PdfArray, PdfDict, PdfName, PdfStream } from "@libpdf/core";
import type { PDF, PdfObject, PdfRef } from "@libpdf/core";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

import { parseCertificate } from "@/api/lib/pdf-signing/certificate-chain";
import type { TrackedRevocationProvider } from "@/api/lib/pdf-signing/revocation";

export type ValidationMaterial = {
  certificates: Uint8Array[];
  crls: Uint8Array[];
  ocspResponses: Uint8Array[];
};

const isSelfSigned = (der: Uint8Array) => {
  const certificate = parseCertificate(der);
  return (
    certificate !== null && certificate.subject.isEqual(certificate.issuer)
  );
};

/** The certificates a timestamp token carries: the TSA's own and its CAs. */
export const timestampTokenCertificates = (token: Uint8Array): Uint8Array[] => {
  try {
    const contentInfo = new pkijs.ContentInfo({
      schema: asn1js.fromBER(new Uint8Array(token)).result,
    });
    const signedData = new pkijs.SignedData({ schema: contentInfo.content });
    return (signedData.certificates ?? [])
      .filter((entry) => entry instanceof pkijs.Certificate)
      .map((entry) => new Uint8Array(entry.toSchema().toBER(false)));
  } catch {
    return [];
  }
};

/**
 * Revocation data for each certificate of `chain` (leaf first, issuers
 * after), OCSP first and the CRL when OCSP has nothing. A self-signed root
 * is trusted by being a root and has nothing to check.
 */
const gatherRevocation = async (
  chain: readonly Uint8Array[],
  provider: TrackedRevocationProvider,
  material: ValidationMaterial,
) => {
  for (const [index, certificate] of chain.entries()) {
    if (isSelfSigned(certificate)) {
      continue;
    }
    const issuer = chain[index + 1];
    const ocsp =
      issuer === undefined
        ? null
        : await provider.getOCSP?.(certificate, issuer);
    if (ocsp) {
      material.ocspResponses.push(ocsp);
      continue;
    }
    const crl = await provider.getCRL?.(certificate);
    if (crl) {
      material.crls.push(crl);
    }
  }
};

export type GatheredValidationData = {
  material: ValidationMaterial;
  /** Signer-chain certificates with no revocation data behind them. */
  uncovered: Uint8Array[];
};

export const gatherValidationData = async ({
  provider,
  signerChain,
  timestampCertificates,
}: {
  provider: TrackedRevocationProvider;
  /** The signing certificate first, then its issuers. */
  signerChain: readonly Uint8Array[];
  timestampCertificates: readonly Uint8Array[];
}): Promise<GatheredValidationData> => {
  const material: ValidationMaterial = {
    certificates: [...signerChain, ...timestampCertificates],
    crls: [],
    ocspResponses: [],
  };
  await gatherRevocation(signerChain, provider, material);
  await gatherRevocation(timestampCertificates, provider, material);

  return {
    material,
    uncovered: signerChain.filter(
      (certificate) =>
        !isSelfSigned(certificate) && !provider.covers(certificate),
    ),
  };
};

/**
 * Append a Document Security Store holding `material` as an incremental
 * update. Entries an earlier DSS already carries are kept, so validation
 * data other signers left behind stays with the document.
 */
export const embedValidationData = async (
  pdf: PDF,
  material: ValidationMaterial,
): Promise<Uint8Array> => {
  const resolve = (ref: PdfRef): PdfObject | null => pdf.getObject(ref);
  const catalog = pdf.getCatalog();
  const existing = catalog.getDict("DSS", resolve);
  const dss = PdfDict.of({ Type: PdfName.of("DSS") });

  const streams = (key: string, entries: readonly Uint8Array[]) => {
    const kept = existing?.getArray(key)?.toArray() ?? [];
    const added = entries.map((entry) =>
      pdf.context.registry.register(new PdfStream(new PdfDict(), entry)),
    );
    if (kept.length + added.length > 0) {
      dss.set(key, new PdfArray([...kept, ...added]));
    }
  };
  streams("Certs", material.certificates);
  streams("OCSPs", material.ocspResponses);
  streams("CRLs", material.crls);
  const vri = existing?.get("VRI");
  if (vri !== undefined) {
    dss.set("VRI", vri);
  }

  catalog.set("DSS", pdf.context.registry.register(dss));
  return await pdf.save({ incremental: true });
};
