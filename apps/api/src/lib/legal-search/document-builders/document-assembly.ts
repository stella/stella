import { panic, Result, TaggedError } from "better-result";

import {
  projectPlainText,
  withProjectedPlainText,
} from "@stll/legal-ast/document-ast";
import type {
  Block,
  DocumentAst,
  DocumentAstMetadata,
  DocumentAstSource,
  Inline,
} from "@stll/legal-ast/document-ast";

import { assignBlockIds } from "./block-ids";
import type { KeyedBlock } from "./block-ids";
import { withLegislationCitations } from "./legislation-citations";

const DOCUMENT_BUILD_FAILURES = ["no-content-root", "no-blocks"] as const;

export class DocumentBuildError extends TaggedError("DocumentBuildError")<{
  message: string;
  reason: (typeof DOCUMENT_BUILD_FAILURES)[number];
}> {}

/** The text axes of a block a builder drafts, derived from its inlines. */
export const draftText = (
  inlines: Inline[],
): { inlines: Inline[]; plainText: string } => ({
  inlines,
  plainText: projectPlainText(inlines),
});

const withCitations = (block: Block): Block => {
  switch (block.type) {
    case "heading":
    case "paragraph": {
      return { ...block, inlines: withLegislationCitations(block.inlines) };
    }
    case "table": {
      return {
        ...block,
        rows: block.rows.map((row) =>
          row.map((cell) => ({
            ...cell,
            inlines: withLegislationCitations(cell.inlines),
          })),
        ),
      };
    }
    case "image": {
      return block;
    }
    default: {
      block satisfies never;
      return panic(`Unhandled block: ${String(block)}`);
    }
  }
};

type AssembleDocumentAstOptions = {
  source: DocumentAstSource;
  metadata: DocumentAstMetadata;
  blocks: readonly KeyedBlock[];
};

/**
 * The last steps every builder shares: structural ids, legislation
 * citations, and `plainText` projected from the final inlines, in that
 * order so no step sees another's intermediate state.
 */
export const assembleDocumentAst = ({
  blocks,
  metadata,
  source,
}: AssembleDocumentAstOptions): Result<DocumentAst, DocumentBuildError> =>
  blocks.length === 0
    ? Result.err(
        new DocumentBuildError({
          message: "the document produced no blocks",
          reason: "no-blocks",
        }),
      )
    : Result.ok(
        withProjectedPlainText({
          version: 1,
          source,
          metadata,
          blocks: assignBlockIds(blocks).map(withCitations),
        }),
      );
