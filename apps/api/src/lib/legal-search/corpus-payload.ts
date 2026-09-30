import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { DecisionSection, EmptyAst } from "./document-types";

export type CorpusPayload = {
  text: string | null;
  sections: DecisionSection[] | null;
  ast: DocumentAst | EmptyAst | null;
};

/**
 * Separates the payload's fields inside the hash, so a document whose
 * text ends where the next field begins cannot collide with a different
 * split of the same bytes. NUL cannot occur in a payload: the pipeline
 * strips it from every stored string. Spelled as an escape because a
 * literal NUL in source makes the file binary to half the toolchain —
 * the byte, and therefore every hash, is unchanged.
 */
const FIELD_SEPARATOR = "\u0000";

/** sha256 over the canonical payload; what object storage is keyed on. */
export const corpusContentHash = ({
  text,
  sections,
  ast,
}: CorpusPayload): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text ?? "");
  hasher.update(FIELD_SEPARATOR);
  hasher.update(JSON.stringify(sections ?? null));
  hasher.update(FIELD_SEPARATOR);
  hasher.update(JSON.stringify(ast ?? null));
  return hasher.digest("hex");
};
