/**
 * Checking the desktop's signature before it is embedded.
 *
 * The desktop is trusted to sign, not to sign correctly: a wrong key picked
 * for the certificate, a card that answered with garbage, or a truncated
 * response would otherwise be embedded and produce a PDF every verifier
 * rejects. The check is the verifier's own: the signature over the CMS
 * signed attributes, against the certificate's public key.
 */

import { verify, X509Certificate } from "node:crypto";

import type { PdfSigningKeyType } from "@/api/db/schema";

export const verifyDesktopSignature = ({
  certificate,
  keyType,
  signature,
  signedAttributes,
}: {
  certificate: Uint8Array;
  keyType: PdfSigningKeyType;
  signature: Uint8Array;
  signedAttributes: Uint8Array;
}): boolean => {
  let publicKey;
  try {
    publicKey = new X509Certificate(Buffer.from(certificate)).publicKey;
  } catch {
    return false;
  }
  try {
    return verify(
      "sha256",
      signedAttributes,
      // A keychain returns ECDSA signatures DER-encoded (X9.62), which is
      // also the form CMS carries; RSA is PKCS#1 v1.5 either way.
      keyType === "EC" ? { key: publicKey, dsaEncoding: "der" } : publicKey,
      signature,
    );
  } catch {
    // A signature too malformed to even parse is simply not valid.
    return false;
  }
};
