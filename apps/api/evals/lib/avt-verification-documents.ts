/**
 * A labelled case's document as a run reads it: the production readers turn
 * a DOCX or PDF into blocks, a printed paragraph range resolves through the
 * production scope, and each labelled claim is located in the passages by
 * its words, as extraction locates a model's quote.
 */
import { panic } from "better-result";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { locateQuote } from "@stll/legal-ast/quote-locate";

import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import {
  docxVerificationBlocks,
  pdfVerificationBlocks,
} from "@/api/lib/lists/verification/document-text";
import {
  resolveParagraphScope,
  scopePassages,
  wholeDocumentPassages,
} from "@/api/lib/lists/verification/paragraph-scope";
import type { VerificationPassage } from "@/api/lib/lists/verification/paragraph-scope";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

import type { LabelledCase, LabelledClaim } from "./avt-verification-set";

/** Where a labelled claim sits: the passage it is in and its offsets in the
 *  passage's whole block, the coordinates extraction anchors in. */
export type LocatedClaim = {
  claim: LabelledClaim;
  passageIndex: number;
  start: number;
  end: number;
};

export type CaseDocument = {
  passages: VerificationPassage[];
  located: LocatedClaim[];
  /** Labelled claims whose words are not in the text the run reads. */
  unlocated: LabelledClaim[];
};

const fileBlocks = async (filePath: string): Promise<VerificationBlock[]> => {
  const bytes = await readFile(filePath);
  if (filePath.toLowerCase().endsWith(".pdf")) {
    return await pdfVerificationBlocks(new Uint8Array(bytes));
  }
  if (filePath.toLowerCase().endsWith(".docx")) {
    return await docxVerificationBlocks(
      testScannedFile({
        bytes: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
        mimeType: DOCX_MIME_TYPE,
      }),
    );
  }
  return panic(`Unsupported document ${filePath}: only DOCX and PDF`);
};

/** Plain paragraphs read as a DOCX's are: one block each. */
const paragraphBlocks = (paragraphs: readonly string[]): VerificationBlock[] =>
  paragraphs.map((text, index) => {
    const id = `p${String(index + 1)}`;
    return {
      id,
      text,
      source: { type: "docx-block", blockId: id },
      structure: { type: "docx-paragraph", label: null, heading: false },
    };
  });

const casePassages = async (
  item: LabelledCase,
  setDirectory: string,
): Promise<VerificationPassage[]> => {
  if (item.document.kind === "paragraphs") {
    return wholeDocumentPassages(paragraphBlocks(item.document.paragraphs));
  }
  const blocks = await fileBlocks(
    path.resolve(setDirectory, item.document.path),
  );
  const range = item.document.range;
  if (range === undefined) {
    return wholeDocumentPassages(blocks);
  }
  const resolution = resolveParagraphScope(blocks, range);
  if (resolution.type !== "resolved") {
    return panic(
      `${item.id}: paragraphs ${String(range.from)}-${String(range.to)} do not resolve (${resolution.type})`,
    );
  }
  return (
    scopePassages(blocks, resolution.scope) ??
    panic(`${item.id}: the resolved range does not land in the blocks`)
  );
};

/** The first place the claim's words are, in its own paragraph when the
 *  label names one of a paragraphs document. */
const locate = (
  claim: LabelledClaim,
  passages: readonly VerificationPassage[],
  paragraphBlockIds: boolean,
): LocatedClaim | null => {
  for (const [passageIndex, passage] of passages.entries()) {
    if (
      paragraphBlockIds &&
      claim.paragraph !== undefined &&
      passage.block.id !== `p${String(claim.paragraph)}`
    ) {
      continue;
    }
    const read = passage.block.text.slice(passage.start, passage.end);
    const span = locateQuote(read, claim.quote, 0);
    if (span !== null) {
      return {
        claim,
        passageIndex,
        start: passage.start + span.start,
        end: passage.start + span.end,
      };
    }
  }
  return null;
};

export const readCaseDocument = async (
  item: LabelledCase,
  setDirectory: string,
): Promise<CaseDocument> => {
  const passages = await casePassages(item, setDirectory);
  const located: LocatedClaim[] = [];
  const unlocated: LabelledClaim[] = [];
  for (const claim of item.claims) {
    const found = locate(claim, passages, item.document.kind === "paragraphs");
    if (found === null) {
      unlocated.push(claim);
    } else {
      located.push(found);
    }
  }
  return { passages, located, unlocated };
};
