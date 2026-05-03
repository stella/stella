import { Fragment } from "react";
import type { ReactNode } from "react";

import type { Citation } from "@/lib/citations";
import type { JustificationContent } from "@/lib/types";

type RenderJustificationContentResult = {
  /**
   * First citable target the renderer encountered, used by the peek
   * to auto-scroll on expand. `null` when there are no citations.
   */
  firstCitation: Citation | null;
  nodes: ReactNode[];
};

type RenderJustificationContentOptions = {
  content: JustificationContent;
  /**
   * When set, only citations whose `fileFieldId` matches contribute
   * to `firstCitation`. The peek uses this to auto-scroll only when
   * the active inspector tab is the same file.
   */
  firstCitationFileFieldId?: string;
  /** One callback handles every citation kind. The implementation
   *  decides whether to render a clickable chip, a quote, or both —
   *  same `Citation` shape regardless of source. */
  renderCitation: (args: {
    citation: Citation;
    /** Stable key for React lists. */
    key: string;
  }) => ReactNode;
};

export const renderJustificationContent = ({
  content,
  firstCitationFileFieldId,
  renderCitation,
}: RenderJustificationContentOptions): RenderJustificationContentResult => {
  const nodes: ReactNode[] = [];
  let firstCitation: Citation | null = null;

  const consider = (citation: Citation) => {
    if (firstCitation !== null) {
      return;
    }
    if (
      firstCitationFileFieldId !== undefined &&
      firstCitationFileFieldId !== citation.fileFieldId
    ) {
      return;
    }
    firstCitation = citation;
  };

  for (const [blockIndex, block] of content.blocks.entries()) {
    if (block.kind === "pdf-bates") {
      for (const [statementIndex, statement] of block.statements.entries()) {
        const statementKey = `${blockIndex}-${statementIndex}`;
        nodes.push(
          <Fragment key={`${statementKey}-text`}>{statement.text} </Fragment>,
        );
        for (const [
          citationIndex,
          { bates, pageNumber },
        ] of statement.citations.entries()) {
          const citation: Citation = {
            kind: "pdf-bates",
            fileFieldId: block.fileFieldId,
            bates,
            pageNumber,
          };
          consider(citation);
          const key = `${statementKey}-${citationIndex}`;
          nodes.push(
            renderCitation({ citation, key }),
            <Fragment key={`${key}-space`}> </Fragment>,
          );
        }
      }
      continue;
    }

    // docx-folio
    for (const [statementIndex, statement] of block.statements.entries()) {
      const statementKey = `${blockIndex}-${statementIndex}`;
      nodes.push(
        <Fragment key={`${statementKey}-text`}>{statement.text} </Fragment>,
      );
      for (const [
        citationIndex,
        { blockId, text },
      ] of statement.citations.entries()) {
        const citation: Citation = {
          kind: "docx-folio",
          fileFieldId: block.fileFieldId,
          blockId,
          text,
        };
        consider(citation);
        const key = `${statementKey}-${citationIndex}`;
        nodes.push(renderCitation({ citation, key }));
      }
    }
  }

  return { firstCitation, nodes };
};
