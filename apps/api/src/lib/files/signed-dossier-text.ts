import { panic } from "better-result";
import type { InferOutput } from "valibot";

import type { signedDossierPreviewSchema } from "@stll/api-contract/signed-dossier";

type Preview = InferOutput<typeof signedDossierPreviewSchema>;

const documentText = ({ status, text }: Preview["documents"][number]) => {
  switch (status) {
    case "readable":
      return text;
    case "truncated":
      return text
        ? `${text}\nDocument text was truncated.`
        : "Document text was truncated.";
    case "unavailable":
      return "Document text unavailable.";
    default:
      status satisfies never;
      return panic("Unknown signed container document status");
  }
};

/** The container as text for search, chat, workflows and document reads. */
export const signedDossierText = ({ documents, signers }: Preview) =>
  [
    "Signed container. Signatures are unverified.",
    ...signers.map(({ name }) => `Signer: ${name ?? "Unknown signer"}`),
    ...documents.map(
      (document) => `Document: ${document.fileName}\n${documentText(document)}`,
    ),
  ].join("\n\n");
