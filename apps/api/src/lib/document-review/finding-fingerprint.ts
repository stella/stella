/**
 * The identity of what a finding actually says, used to decide whether a
 * re-run reached the same conclusion about the same text.
 *
 * A reviewer's decision is a judgment about evidence, not about a row, so it
 * survives a re-run exactly as far as the evidence does: same verdict over the
 * same quoted passages means the decision still applies, anything else means
 * the reviewer has to look again.
 *
 * What the fingerprint covers, and why only this:
 *
 *  - the stored outcome — a changed verdict is by definition a new judgment;
 *  - the extracted value and the text it was read from;
 *  - the literal excerpts of every verified citation, on the document's side
 *    and on the standard's, per cited document.
 *
 * What it deliberately excludes:
 *
 *  - block ids. A folio block id is a `w14:paraId` where the DOCX carries one
 *    and a positional `seq-NNNN` otherwise, so an edit elsewhere in the
 *    document renumbers untouched paragraphs. Fingerprinting position would
 *    reopen decisions about text nobody changed.
 *  - model prose (rationale, explanation, recommendation, fix) and the delta's
 *    typing. Two runs phrase the same conclusion differently; treating that as
 *    new evidence would make carry-over almost never fire.
 *
 * Excerpts are whitespace-normalized before comparison: re-extraction can
 * differ in wrapping without differing in content.
 */

import { arrayOrEmpty } from "@/api/lib/array";
import { stableStringify } from "@stll/stable-stringify";
import type { DocumentReviewFindingPayload } from "@/api/lib/document-review/run-contract";

const WHITESPACE_RUN = /\s+/gu;

/** One excerpt reduced to its content: leading, trailing, and internal
 *  whitespace runs carry no meaning in a quoted passage. */
const normalizeExcerpt = (text: string): string =>
  text.replace(WHITESPACE_RUN, " ").trim();

/**
 * The excerpts of a citation list, order-independent. The model may emit the
 * same set of passages in a different order between runs; the set is the
 * evidence, the order is not. Empty excerpts drop out: they quote nothing.
 */
const citationExcerpts = (
  citations: readonly { text: string }[],
): readonly string[] =>
  citations
    .map(({ text }) => normalizeExcerpt(text))
    .filter((text) => text.length > 0)
    .toSorted();

/** The evidence a finding rests on: what the document said, and what it was
 *  measured against. */
type FindingEvidence = {
  extractedValue: string | null;
  extractedText: string | null;
  citations: readonly string[];
  standardCitations: readonly {
    fileFieldId: string;
    citations: readonly string[];
  }[];
};

const findingEvidence = (
  payload: DocumentReviewFindingPayload,
): FindingEvidence => {
  const { finding } = payload;
  const extracted = finding.extracted;
  return {
    extractedValue:
      extracted === null ? null : normalizeExcerpt(extracted.value),
    extractedText: extracted === null ? null : normalizeExcerpt(extracted.text),
    citations: citationExcerpts(finding.citations),
    // Evidence from a different reference document is different evidence, so
    // each file's excerpts stay attributed to it. Sorted by the pinned file
    // field id, which is stable across runs.
    standardCitations: arrayOrEmpty(finding.referenceCitations)
      .map((entry) => ({
        fileFieldId: entry.fileFieldId,
        citations: entry.passages.map((passage) => passage.id).toSorted(),
      }))
      .toSorted((left, right) =>
        left.fileFieldId < right.fileFieldId
          ? -1
          : Number(left.fileFieldId > right.fileFieldId),
      ),
  };
};

/**
 * A stable hex digest of one finding's conclusion and evidence. Equal
 * fingerprints mean a re-run said the same thing about the same passages;
 * unequal ones mean the reviewer's earlier decision was about something else.
 *
 * `outcome` is passed rather than re-derived so the fingerprint describes the
 * row as stored, not as the payload could be re-read.
 */
export const findingFingerprint = (
  payload: DocumentReviewFindingPayload,
  outcome: string | null,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(
      stableStringify({
        outcome,
        evidence: findingEvidence(payload),
      }),
    )
    .digest("hex");
