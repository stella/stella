import { Result } from "better-result";

import type { JustificationContent } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type JustificationFilenames = {
  original: string;
  simplified: string;
  fileFieldId: SafeId<"field">;
}[];

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

const parseCitation = (citation: string, file: string) => {
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

export const normalizeJustification = ({
  justification,
  filenames,
}: NormalizeJustificationProps): Result<ParsedJustification | null, never> => {
  const blocks: JustificationContent["blocks"] = [];
  const fileFieldIdSet = new Set<SafeId<"field">>();

  for (const block of justification) {
    const file = filenames.find(
      (filename) => filename.simplified === block.file,
    );

    if (!file) {
      continue;
    }

    const statements: JustificationContent["blocks"][number]["statements"] = [];

    for (const statement of block.statements) {
      const text = statement.text.trim();

      if (text.length === 0) {
        continue;
      }

      const citations = statement.citations
        .map((citation) => parseCitation(citation, file.simplified))
        .filter((citation) => citation !== null);

      if (citations.length === 0) {
        continue;
      }

      statements.push({ text, citations });
    }

    if (statements.length === 0) {
      continue;
    }

    fileFieldIdSet.add(file.fileFieldId);
    blocks.push({ fileFieldId: file.fileFieldId, statements });
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
