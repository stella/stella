/**
 * Read a decision's passages back out of storage and address one by anchor id.
 *
 * Takes `{ documentId, anchorId }` per hit plus the decisions' payload pointers
 * and returns one result per request, in request order. The payload is chunked
 * with `chunkDocument`, so a returned passage is the passage that was indexed;
 * the anchor is a chunk's first block, so it names exactly one chunk.
 *
 * A passage from the plain-text fallback carries no anchor and is reported as
 * `unanchored` rather than located by position.
 */

import { inArray } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import { hasUsableAst } from "@/api/lib/case-law/document-ast";
import { chunkDocument } from "@/api/lib/corpus-index/chunking";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

/** Where one decision's payload lives, as the row stores it. */
type CorpusPassagePointer = {
  documentId: string;
  textS3Key: string | null;
  astS3Key: string | null;
};

/** One hit, as the two fields the passage is addressed by. */
type CorpusPassageRequest = {
  documentId: string;
  /** The hit's `anchor_id`; null for a passage cut from unstructured text. */
  anchorId: string | null;
};

/** The passage, or why there is none. Every miss is a value, not a throw. */
export type CorpusPassageResult =
  | { status: "found"; documentId: string; seq: number; text: string }
  /** The hit carries no anchor, so no single passage is named. */
  | { status: "unanchored"; documentId: string }
  /** The decision is gone, or its payload pointer was never written. */
  | { status: "no_payload"; documentId: string }
  /** The document was read, but no passage of it starts at this anchor. */
  | { status: "anchor_not_found"; documentId: string; anchorId: string };

type PassageSelection =
  | { status: "found"; seq: number; text: string }
  | { status: "anchor_not_found" };

/** The passage of this payload that starts at `anchorId`. Pure. */
export const selectCorpusPassage = ({
  ast,
  text,
  anchorId,
}: {
  ast: DocumentAst | EmptyAst | null;
  text: string;
  anchorId: string;
}): PassageSelection => {
  const chunks = chunkDocument({
    ast: hasUsableAst(ast) ? ast : null,
    fallbackText: text,
  });
  const chunk = chunks.find((candidate) => candidate.anchorId === anchorId);
  return chunk === undefined
    ? { status: "anchor_not_found" }
    : { status: "found", seq: chunk.seq, text: chunk.text };
};

/** Payload pointers for the named decisions, in one statement. */
export const readCaseLawPassagePointersTx = async (
  tx: Transaction,
  documentIds: readonly string[],
): Promise<CorpusPassagePointer[]> => {
  if (documentIds.length === 0) {
    return [];
  }
  const ids = documentIds.map((id) => brandPersistedCaseLawDecisionId(id));
  const rows = await tx
    .select({
      documentId: caseLawDecisions.id,
      textS3Key: caseLawDecisions.textS3Key,
      astS3Key: caseLawDecisions.astS3Key,
    })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, ids))
    .limit(ids.length);
  return rows.map((row) => ({
    documentId: String(row.documentId),
    textS3Key: row.textS3Key,
    astS3Key: row.astS3Key,
  }));
};

/** The two payload reads, as a seam a test can fill with a fixture. */
export type CorpusPayloadSource = {
  readText: (storedKey: string) => Promise<string>;
  readAst: (storedKey: string) => Promise<DocumentAst | EmptyAst | null>;
};

const corpusPayloadStorage: CorpusPayloadSource = {
  readText: async (storedKey) => await readCorpusText(storedKey),
  readAst: async (storedKey) => await readCorpusAst(storedKey),
};

type ReadCorpusPassagesOptions = {
  requests: readonly CorpusPassageRequest[];
  pointers: readonly CorpusPassagePointer[];
  source?: CorpusPayloadSource;
};

/** A decision's payload, as the chunker takes it. */
type LoadedPayload = { ast: DocumentAst | EmptyAst | null; text: string };

/** Both halves of one decision's payload; no AST pointer means no AST. */
const loadPayload = async ({
  source,
  textKey,
  astKey,
}: {
  source: CorpusPayloadSource;
  textKey: string;
  astKey: string | null;
}): Promise<LoadedPayload> => ({
  text: await source.readText(textKey),
  ast: astKey === null ? null : await source.readAst(astKey),
});

/**
 * One result per request, in request order. A document's payload is read once
 * however many of the requests name it.
 */
export const readCorpusPassages = async ({
  requests,
  pointers,
  source = corpusPayloadStorage,
}: ReadCorpusPassagesOptions): Promise<CorpusPassageResult[]> => {
  const pointerById = new Map(
    pointers.map((pointer) => [pointer.documentId, pointer]),
  );
  const payloads = new Map<string, Promise<LoadedPayload | null>>();
  const payloadOf = async (
    documentId: string,
  ): Promise<LoadedPayload | null> => {
    const started = payloads.get(documentId);
    if (started !== undefined) {
      return await started;
    }
    const pointer = pointerById.get(documentId);
    const textKey = pointer?.textS3Key ?? null;
    const astKey = pointer?.astS3Key ?? null;
    const load: Promise<LoadedPayload | null> =
      textKey === null
        ? Promise.resolve(null)
        : loadPayload({ source, textKey, astKey });
    payloads.set(documentId, load);
    return await load;
  };

  const results: CorpusPassageResult[] = [];
  for (const { documentId, anchorId } of requests) {
    if (anchorId === null) {
      results.push({ status: "unanchored", documentId });
      continue;
    }
    const payload = await payloadOf(documentId);
    if (payload === null) {
      results.push({ status: "no_payload", documentId });
      continue;
    }
    const selected = selectCorpusPassage({ ...payload, anchorId });
    results.push(
      selected.status === "found"
        ? {
            status: "found",
            documentId,
            seq: selected.seq,
            text: selected.text,
          }
        : { status: "anchor_not_found", documentId, anchorId },
    );
  }
  return results;
};
