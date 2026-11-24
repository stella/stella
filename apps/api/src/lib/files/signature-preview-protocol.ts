import * as v from "valibot";

import { SIGNATURE_PACKAGINGS } from "@stll/api-contract/signature";

import { SIGNED_DIGEST_ALGORITHMS } from "@/api/lib/files/cms-signed-data";

export const SIGNATURE_WORKER_MODE = {
  preview: "signature-preview",
} as const;

export const SIGNATURE_WORKER_EXIT = {
  unreadable: 20,
  rejected: 21,
} as const;

/** What the worker reads from one signature file, before any matter lookup. */
export const signatureWorkerReplySchema = v.object({
  standard: v.picklist(["cades", "xades"]),
  packaging: v.picklist(SIGNATURE_PACKAGINGS),
  signers: v.array(
    v.object({
      id: v.string(),
      name: v.nullable(v.string()),
      signedAt: v.nullable(v.string()),
    }),
  ),
  references: v.array(
    v.object({
      fileName: v.nullable(v.string()),
      digest: v.nullable(
        v.object({
          algorithm: v.picklist(Object.values(SIGNED_DIGEST_ALGORITHMS)),
          hex: v.pipe(v.string(), v.regex(/^[0-9a-f]{40,128}$/u)),
        }),
      ),
    }),
  ),
  document: v.nullable(
    v.object({
      fileName: v.string(),
      mimeType: v.string(),
      text: v.string(),
    }),
  ),
});

export type SignatureWorkerReply = v.InferOutput<
  typeof signatureWorkerReplySchema
>;
