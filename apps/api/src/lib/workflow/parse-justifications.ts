import { Result } from "better-result";

import { isFolioBlockId } from "@stll/folio/server";
import type { FolioBlockId } from "@stll/folio/server";

import type {
  DocxFolioJustificationBlock,
  JustificationBlock,
  JustificationContent,
  PdfBatesJustificationBlock,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type JustificationFilename = {
  original: string;
  simplified: string;
  fileFieldId: SafeId<"field">;
} & (
  | { kind: "pdf-bates" }
  | {
      kind: "docx-folio";
      /** Block text keyed by id — used both as the allow-list for
       *  AI citations AND to embed the quoted text in the saved
       *  justification so the frontend can render it without
       *  re-fetching/re-parsing the DOCX. */
      blocksById: ReadonlyMap<FolioBlockId, string>;
    }
);

export type JustificationFilenames = JustificationFilename[];

export type AIJustificationOutput = {
  file: string;
  statements: {
    text: string;
    citations: string[];
  }[];
}[];

type NormalizeJustificationProps = {
  justification: AIJustificationOutput;
  filenames: JustificationFilenames;
};

type ParsedJustification = {
  content: JustificationContent;
  fileFieldIds: SafeId<"field">[];
};

const parseBatesCitation = (citation: string, file: string) => {
  const trimmed = citation.trim();
  const prefix = `${file}-`;

  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  const pageSegment = trimmed.slice(prefix.length);
  const pageNumber = Number(pageSegment);

  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return null;
  }

  return { bates: trimmed, pageNumber };
};

const buildPdfBlock = (
  file: Extract<JustificationFilename, { kind: "pdf-bates" }>,
  rawStatements: AIJustificationOutput[number]["statements"],
): PdfBatesJustificationBlock | null => {
  const statements: PdfBatesJustificationBlock["statements"] = [];

  for (const statement of rawStatements) {
    const text = statement.text.trim();
    if (text.length === 0) {
      continue;
    }

    const citations = statement.citations
      .map((citation) => parseBatesCitation(citation, file.simplified))
      .filter((citation) => citation !== null);

    if (citations.length === 0) {
      continue;
    }

    statements.push({ text, citations });
  }

  if (statements.length === 0) {
    return null;
  }

  return { kind: "pdf-bates", fileFieldId: file.fileFieldId, statements };
};

const buildDocxBlock = (
  file: Extract<JustificationFilename, { kind: "docx-folio" }>,
  rawStatements: AIJustificationOutput[number]["statements"],
): DocxFolioJustificationBlock | null => {
  const statements: DocxFolioJustificationBlock["statements"] = [];

  for (const statement of rawStatements) {
    const text = statement.text.trim();
    if (text.length === 0) {
      continue;
    }

    // Citations on a DOCX file are folio block IDs minted by
    // `deriveBlockId` (paraId verbatim, or `seq-NNNN` fallback).
    // Drop ids the model invented or that don't structurally pass
    // the runtime check, then dedupe; embed the literal block text
    // alongside each id so the frontend can render the quote
    // without a round-trip to the document.
    const seen = new Set<FolioBlockId>();
    const citations: DocxFolioJustificationBlock["statements"][number]["citations"] =
      [];
    for (const raw of statement.citations) {
      const trimmed = raw.trim();
      if (!isFolioBlockId(trimmed)) {
        continue;
      }
      if (seen.has(trimmed)) {
        continue;
      }
      const blockText = file.blocksById.get(trimmed);
      if (blockText === undefined) {
        continue;
      }
      seen.add(trimmed);
      citations.push({ blockId: trimmed, text: blockText });
    }

    if (citations.length === 0) {
      continue;
    }

    statements.push({ text, citations });
  }

  if (statements.length === 0) {
    return null;
  }

  return { kind: "docx-folio", fileFieldId: file.fileFieldId, statements };
};

export const normalizeJustification = ({
  justification,
  filenames,
}: NormalizeJustificationProps): Result<ParsedJustification | null, never> => {
  const blocks: JustificationBlock[] = [];
  const fileFieldIdSet = new Set<SafeId<"field">>();

  for (const block of justification) {
    const file = filenames.find(
      (filename) => filename.simplified === block.file,
    );

    if (!file) {
      continue;
    }

    const built =
      file.kind === "pdf-bates"
        ? buildPdfBlock(file, block.statements)
        : buildDocxBlock(file, block.statements);

    if (built === null) {
      continue;
    }

    fileFieldIdSet.add(file.fileFieldId);
    blocks.push(built);
  }

  if (blocks.length === 0) {
    return Result.ok(null);
  }

  return Result.ok({
    content: {
      version: 1,
      blocks,
    },
    fileFieldIds: [...fileFieldIdSet],
  });
};
