import { Result } from "better-result";

import type {
  DocxFolioJustificationBlock,
  DocxFolioJustificationCitation,
  JustificationBlock,
  JustificationContent,
  PdfBatesJustificationBlock,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { citationTextMatches } from "@/api/lib/workflow/citation-normalize";

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
      blocksById: ReadonlyMap<string, string>;
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

// Resolve a model-supplied quote to an allow-listed block by normalized
// text match. A citation is frequently a span of a larger paragraph, so
// this rescues quotes the model pasted verbatim (rather than by id) even
// when a non-breaking space, curly quote, dash variant, or decomposed
// accent differs from the stored block. Returns the FIRST matching block
// so the resolved id is deterministic given a stable block order.
type ResolvedBlock = { blockId: string; text: string };

const resolveQuoteToBlock = (
  quote: string,
  blocksById: ReadonlyMap<string, string>,
): ResolvedBlock | null => {
  for (const [blockId, text] of blocksById) {
    if (citationTextMatches({ quote, source: text })) {
      return { blockId, text };
    }
  }
  return null;
};

// Classify one raw citation string against the DOCX allow-list.
//   - A string that is itself an allow-listed block id -> verified (embed
//     the block's literal text so the client renders the quote without a
//     document round-trip).
//   - Otherwise, a string that reads as prose (contains whitespace) is
//     treated as a pasted quote: matched to a block -> verified; matched
//     to nothing -> unverified, kept as a non-navigable hint so a lawyer
//     sees the model gestured at a source that isn't grounded.
//   - A single opaque token that is neither an allow-listed id nor prose
//     (a hallucinated/malformed id like `seq-9999`) carries no readable
//     quote and cannot be grounded, so it is dropped.
//
// Note: `isFolioBlockId` is a structural refinement that accepts almost
// any non-empty string as a possible paraId, so it cannot separate a real
// id from a pasted quote. Allow-list membership is the true gate; a raw
// blockId that is not in the map is exactly a hallucinated reference.
type ClassifiedCitation = DocxFolioJustificationCitation | null;

const classifyDocxCitation = (
  raw: string,
  blocksById: ReadonlyMap<string, string>,
): ClassifiedCitation => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const directText = blocksById.get(trimmed);
  if (directText !== undefined) {
    return { citationStatus: "verified", blockId: trimmed, text: directText };
  }

  // A prose gate (contains whitespace) keeps a short opaque token from
  // spuriously matching a block via substring containment and from being
  // surfaced as an ungrounded "quote".
  if (!/\s/u.test(trimmed)) {
    return null;
  }

  const resolved = resolveQuoteToBlock(trimmed, blocksById);
  if (resolved) {
    return {
      citationStatus: "verified",
      blockId: resolved.blockId,
      text: resolved.text,
    };
  }

  return { citationStatus: "unverified", text: trimmed };
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

    // Dedupe verified citations by resolved block id and unverified ones
    // by their normalized-but-displayed raw text, so a statement never
    // repeats the same source anchor or the same ungrounded hint.
    const seenBlockIds = new Set<string>();
    const seenUnverified = new Set<string>();
    const citations: DocxFolioJustificationBlock["statements"][number]["citations"] =
      [];
    for (const raw of statement.citations) {
      const classified = classifyDocxCitation(raw, file.blocksById);
      if (classified === null) {
        continue;
      }
      if (classified.citationStatus === "verified") {
        if (seenBlockIds.has(classified.blockId)) {
          continue;
        }
        seenBlockIds.add(classified.blockId);
        citations.push(classified);
        continue;
      }
      if (seenUnverified.has(classified.text)) {
        continue;
      }
      seenUnverified.add(classified.text);
      citations.push(classified);
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
  const filenamesBySimplified = new Map(
    filenames.map((filename) => [filename.simplified, filename]),
  );

  for (const block of justification) {
    const file = filenamesBySimplified.get(block.file);

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
