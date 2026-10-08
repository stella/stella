import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { createSha256 } from "@stll/sha256/bun";

import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";

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
  const hasher = createSha256();
  hasher.update(text ?? "");
  hasher.update(FIELD_SEPARATOR);
  hasher.update(JSON.stringify(sections ?? null));
  hasher.update(FIELD_SEPARATOR);
  hasher.update(JSON.stringify(ast ?? null));
  return hasher.digest("hex");
};

/**
 * The content hashes of a payload that carries no document.
 *
 * A metadata-first ingest stores the decision's identity and leaves the
 * document to a later fetch, so under dual-write or canonical storage it
 * still writes a corpus payload — an empty one. Those objects are
 * indistinguishable from a real payload by key alone, so the hash is
 * what identifies them: a row still carrying one of these has nothing
 * readable in object storage, whatever its Postgres columns say.
 *
 * Derived rather than written down, so a change to the hash function or
 * to the empty shapes cannot leave a stale constant behind. `null` and
 * `""` text hash alike (the hasher coalesces), so the variants are the
 * cross product of the empty sections shapes (none, or a stored `[]`)
 * with the constant empty AST shapes (the `EMPTY_AST` placeholder, or
 * none at all). A structurally valid AST with no blocks is deliberately
 * NOT here — its envelope carries per-document metadata, so its hash is
 * row-specific and no constant can name it; those rows are recognised
 * structurally instead (see stored-payload.ts).
 */
const EMPTY_SECTION_SHAPES: readonly (DecisionSection[] | null)[] = [null, []];
// A full `DocumentAst` with an empty `blocks` array is NOT representable
// here: it carries per-document `source`/`metadata`, so its hash is
// row-specific and no constant can name it. Such a row (empty text, empty
// blocks, populated envelope) is judged by the Postgres-side structural
// predicate instead; the hash constants cover every payload whose empty
// shape is content-independent.
const EMPTY_AST_SHAPES: readonly (DocumentAst | EmptyAst | null)[] = [
  EMPTY_AST,
  null,
];

export const EMPTY_CORPUS_CONTENT_HASHES: readonly string[] =
  EMPTY_SECTION_SHAPES.flatMap((sections) =>
    EMPTY_AST_SHAPES.map((ast) =>
      corpusContentHash({ text: null, sections, ast }),
    ),
  );
