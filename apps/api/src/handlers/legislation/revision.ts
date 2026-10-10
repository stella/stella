import { createStatuteSlug } from "@stll/api-contract/statute-route";
import { createSha256 } from "@stll/sha256/bun";

import { corpusStorageMode } from "@/api/env-base";
import { storedWindow } from "@/api/handlers/legislation/version-windows";
import type { StoredWindow } from "@/api/handlers/legislation/version-windows";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import {
  sanitizeMetadata,
  stripDangerousChars,
} from "@/api/lib/legal-search/corpus-sanitize";
import {
  corpusContentHash,
  writeCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type { CorpusWriteOutcome } from "@/api/lib/legal-search/corpus-storage";
import { typedLegislationClassification } from "@/api/lib/legal-search/legislation-expression-classification";
import type { LegislationExpressionClassification } from "@/api/lib/legal-search/legislation-expression-classification";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";

const sanitizeInput = (
  input: LegislationDocumentInput,
): LegislationDocumentInput => ({
  ...input,
  eli: stripDangerousChars(input.eli),
  title: stripDangerousChars(input.title),
  fulltext:
    input.fulltext === null || input.fulltext === undefined
      ? null
      : stripDangerousChars(input.fulltext),
  sourceRaw:
    input.sourceRaw === undefined
      ? undefined
      : stripDangerousChars(input.sourceRaw),
  metadata: sanitizeMetadata(input.metadata ?? {}),
  expression:
    input.expression === undefined
      ? undefined
      : {
          ...input.expression,
          publisherId: stripDangerousChars(input.expression.publisherId),
        },
});

/**
 * Hash over every persisted, search-visible field — not just the corpus
 * payload — so a source re-emitting identical text with changed metadata
 * (title, status, dates, URLs) still updates the row instead of hitting
 * the dedup skip.
 *
 * `rawHash` is in it for the opposite reason: a publisher may change
 * something this parser does not yet read, and without the observation
 * fingerprint that change hashes identically and the row can never be
 * refreshed once a later parser learns to read it.
 *
 * The version's classification is appended only when it is one a writer could
 * not state before classifications existed, so every hash stored before then
 * keeps its bytes and an unchanged re-ingest of such a row stays a skip.
 */
export const legislationSourceHash = (
  input: LegislationDocumentInput,
  window: StoredWindow,
  classification: LegislationExpressionClassification,
): string => {
  const typed = typedLegislationClassification(classification);
  const hasher = createSha256();
  hasher.update(
    JSON.stringify([
      input.eli,
      input.title,
      input.country,
      input.language,
      input.documentType ?? null,
      input.status ?? "current",
      input.effectiveDate ?? null,
      // The stored bounds, not the declaration: a connector that starts
      // declaring the same publisher date differently has changed what the
      // row says, and the hash has to move with the column.
      window.versionValidFrom,
      window.versionValidTo,
      input.fulltext ?? null,
      input.sections ?? null,
      input.ast ?? null,
      input.sourceUrl ?? null,
      input.documentUrl ?? null,
      input.metadata ?? {},
      input.rawHash,
      input.sourceRawContentType ?? null,
      ...(typed === null
        ? []
        : [
            [
              typed.expressionKind,
              typed.windowDisposition,
              typed.windowDispositionBasis,
            ],
          ]),
    ]),
  );
  return hasher.digest("hex");
};

export type LegislationCorpusDependencies = {
  mode: CorpusStorageMode;
  write: typeof writeCorpusDocument;
};

export const LEGISLATION_CORPUS_DEPENDENCIES: LegislationCorpusDependencies = {
  mode: corpusStorageMode,
  write: writeCorpusDocument,
};

// Not exported as a constructor: only a revision can pair a storage result
// with the source fingerprint used to commit its metadata.
class RevisionProjection {
  readonly #sourceHash: string;
  readonly #outcome: CorpusWriteOutcome | null;

  constructor(sourceHash: string, outcome: CorpusWriteOutcome | null) {
    this.#sourceHash = sourceHash;
    this.#outcome = structuredClone(outcome);
  }

  get sourceHash() {
    return this.#sourceHash;
  }
  get outcome() {
    return structuredClone(this.#outcome);
  }
}

export type LegislationRevisionProjection = RevisionProjection;

type WriteRevisionCorpusOptions = {
  documentId: string;
  stored: Parameters<typeof writeCorpusDocument>[0]["stored"];
  classification: LegislationExpressionClassification;
  write: typeof writeCorpusDocument;
};

type RevisionSourceRaw = {
  sourceRawS3Key: string | null;
  sourceRawContentType: string | null;
};

/** One fetched revision owns both its database fields and corpus payload. */
export class LegislationRevision {
  readonly #input: LegislationDocumentInput;
  readonly #contentHash: string;

  constructor(input: LegislationDocumentInput) {
    // Sanitizing first turns values structuredClone rejects (functions,
    // symbols, promises in metadata) into storable ones before the snapshot.
    this.#input = structuredClone(sanitizeInput(input));
    this.#contentHash = corpusContentHash({
      text: this.#input.fulltext ?? null,
      sections: this.#input.sections ?? null,
      ast: this.#input.ast ?? null,
    });
  }

  // Reads cannot mutate the snapshot used by either writer.
  get input() {
    return structuredClone(this.#input);
  }
  get window() {
    return storedWindow(this.#input.version);
  }
  get payload() {
    return {
      text: this.#input.fulltext ?? null,
      sections: structuredClone(this.#input.sections ?? null),
      ast: structuredClone(this.#input.ast ?? null),
    };
  }
  get contentHash() {
    return this.#contentHash;
  }

  sourceHash(classification: LegislationExpressionClassification) {
    return legislationSourceHash(this.#input, this.window, classification);
  }

  values(sourceRaw: RevisionSourceRaw) {
    const input = this.#input;
    const { text, sections, ast } = this.payload;
    const window = this.window;
    return {
      sourceId: input.sourceId,
      eli: input.eli,
      slug: createStatuteSlug({ eli: input.eli, title: input.title }),
      title: input.title,
      country: input.country,
      language: input.language,
      documentType: input.documentType ?? null,
      status: input.status ?? "current",
      effectiveDate: input.effectiveDate ?? null,
      ...window,
      fulltext: text,
      sections,
      documentAst: ast,
      sourceUrl: input.sourceUrl ?? null,
      documentUrl: input.documentUrl ?? null,
      metadata: structuredClone(input.metadata ?? {}),
      sourceRawS3Key: sourceRaw.sourceRawS3Key,
      sourceRawContentType: sourceRaw.sourceRawContentType,
    };
  }

  withoutCorpusWrite(
    classification: LegislationExpressionClassification,
  ): LegislationRevisionProjection {
    return new RevisionProjection(this.sourceHash(classification), null);
  }

  async writeCorpus({
    documentId,
    stored,
    classification,
    write,
  }: WriteRevisionCorpusOptions): Promise<LegislationRevisionProjection> {
    const sourceHash = this.sourceHash(classification);
    const outcome = await write({
      documentId,
      jurisdiction: this.#input.country,
      ...this.payload,
      stored,
    });
    return new RevisionProjection(sourceHash, outcome);
  }
}
